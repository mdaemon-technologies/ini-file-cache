import * as fs from "fs";
import * as path from "path";
import Emitter from "@mdaemon/emitter/dist/emitter.cjs";

interface ISetting {
  key: string;
  value: string;
}

interface ISection {
  name: string;
  settings: ISetting[];
}

async function lockFile(file: string) {
  const lock = path.join(path.dirname(file), ".lck");
  let attempts = 0;
  while (fs.existsSync(lock) && attempts < 20) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempts++;
  }
  if (!fs.existsSync(lock)) {
    fs.writeFileSync(lock, "");
  }
}

function unlockFile(file: string) {
  const lock = path.join(path.dirname(file), ".lck");
  if (fs.existsSync(lock)) {
    fs.unlinkSync(lock);
  }
}

export default class IniFileCache {
  private file: string;
  private settings: ISection[];
  private watching: any;
  private _listener: any;
  constructor(private readonly cachePath: string, private readonly fileName: string) {
    this.settings = [];
    this._listener = new Emitter();
    this.file = path.join(this.cachePath, this.fileName);
    if (!fs.existsSync(this.cachePath)) {
      fs.mkdirSync(this.cachePath, { recursive: true });
    }
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, "");
    }

    this.cacheFileSettings();
    this.watching = null;
    this.watch();

  }

  get listener() {
    return this._listener;
  }

  parseContents(contents: string) {
    const lines = contents.split(/\r\n|\n|\r/);
    const sections: ISection[] = [];
    let currentSection: ISection | null = null;
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith("[") && trimmedLine.endsWith("]")) {
        const sectionName = trimmedLine.slice(1, -1);
        currentSection = { name: sectionName, settings: [] };
        sections.push(currentSection);
      } else if (trimmedLine.startsWith(";") || trimmedLine.startsWith("#")) {
        // Ignore comments
      } else if (trimmedLine && currentSection) {
        const [key, value] = trimmedLine.split("=");
        currentSection.settings.push({ key, value });
      }
    }

    if (lines.length && !currentSection) {
      this.settings = [];
      this.listener.emit("error", new Error("Invalid ini file format"));
      return;
    }

    this.settings = sections;
  }

  async cacheFileSettings() {
    let retryCount = 0;
    const maxRetries = 20;
    const retryDelay = 100; // ms

    await new Promise(res => {
      while (retryCount < maxRetries) {
        try {
          const contents: string = fs.readFileSync(this.file, "utf8");
          this.parseContents(contents);
          res(undefined);
          return;
        } catch (error) {
          if (retryCount === maxRetries - 1) {
            this.listener.emit("error", new Error(`Failed to read file after ${maxRetries} attempts: ${error}`));
            return;
          }
          retryCount++;
          // Wait before retrying
          new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    })
  }

  getSetting(section: string, key: string, defaultValue: string = ""): string | null {
    const sectionObj = this.settings.find((s) => s.name === section);
    if (!sectionObj) {
      return defaultValue || null;
    }
    const setting = sectionObj.settings.find((s) => s.key === key);
    if (!setting) {
      return defaultValue || null;
    }
    return setting.value;
  }

  setSetting(section: string, key: string, value: string) {
    const sectionObj = this.settings.find((s) => s.name === section);
    if (!sectionObj) {
      this.settings.push({ name: section, settings: [{ key, value }] });
      return;
    }
    const setting = sectionObj.settings.find((s) => s.key === key);
    if (!setting) {
      sectionObj.settings.push({ key, value });
      return;
    }

    setting.value = value;
  }

  getSections() {
    return this.settings.map((s) => s.name);
  }

  getKeys(section: string) {
    const sectionObj = this.settings.find((s) => s.name === section);
    if (!sectionObj) {
      return [];
    }
    return sectionObj.settings.map((s) => s.key);
  }

  hasSection(section: string) {
    return this.settings.some((s) => s.name === section);
  }

  hasKey(section: string, key: string) {
    const sectionObj = this.settings.find((s) => s.name === section);
    if (!sectionObj) {
      return false;
    }
    return sectionObj.settings.some((s) => s.key === key);
  }

  removeSection(section: string) {
    const index = this.settings.findIndex((s) => s.name === section);
    if (index !== -1) {
      this.settings.splice(index, 1);
    }
  }

  removeKey(section: string, key: string) {
    const sectionObj = this.settings.find((s) => s.name === section);
    if (!sectionObj) {
      return;
    }
    const index = sectionObj.settings.findIndex((s) => s.key === key);
    if (index !== -1) {
      sectionObj.settings.splice(index, 1);
    }
  }

  async reload() {
    await this.cacheFileSettings();
    this.listener.emit("reload", this.file);
  }

  async save() {
    let contents = "";
    for (const section of this.settings) {
      contents += `[${section.name}]\n`;
      for (const setting of section.settings) {
        contents += `${setting.key}=${setting.value}\n`;
      }
      contents += "\n";
    }

    await lockFile(this.file);
    try {
      fs.writeFileSync(this.file, contents, { flush: true });
      unlockFile(this.file);
      this.listener.emit("save", this.file);
    }
    catch (error) {
      unlockFile(this.file);
      this.listener.emit("error", error);
    }
  }

  watch() {
    this.watching = fs.watch(this.file, async (event, filename) => {
      if (event === "change") {
        await this.cacheFileSettings();
        this.listener.emit("change", filename);
      }
    });

    if (this.watching) {
      this.watching.on("error", (error: Error) => {
        this.listener.emit("error", error);
      });
  
      this.watching.once("close", () => {
        this.listener.emit("close");
      });
      return;
    }

    this.listener.emit("error", new Error("Failed to watch file"));
  }

  unwatch() {
    if (this.watching) {
      fs.unwatchFile(this.file);
      this.watching = null;
    }
  }


}