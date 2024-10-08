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

function lockFile(file: string) {
  const lockFile = path.join(path.dirname(file), ".lck");
  if (!fs.existsSync(lockFile)) {
    fs.writeFileSync(lockFile, "");
  }
}

function unlockFile(file: string) {
  const lockFile = path.join(path.dirname(file), ".lck");
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
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

  cacheFileSettings() {
    const contents: string = fs.readFileSync(this.file, "utf8");
    this.parseContents(contents);
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

  reload() {
    this.cacheFileSettings();
    this.listener.emit("reload", this.file);
  }

  save() {
    let contents = "";
    for (const section of this.settings) {
      contents += `[${section.name}]\n`;
      for (const setting of section.settings) {
        contents += `${setting.key}=${setting.value}\n`;
      }
      contents += "\n";
    }

    lockFile(this.file);
    fs.writeFileSync(this.file, contents, { flush: true });
    unlockFile(this.file);
    this.listener.emit("save", this.file);
  }

  watch() {
    this.watching = fs.watch(this.file, (event, filename) => {
      if (event === "change") {
        this.cacheFileSettings();
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