/** A setting as the file spells it. */
export interface IIniSetting {
  readonly key: string;
  readonly value: string;
}

/** A section as the file spells it, with its settings in the file's own order. */
export interface IIniSectionView {
  readonly name: string;
  readonly settings: readonly IIniSetting[];
}

interface Setting {
  key: string;
  value: string;
}

interface Section {
  name: string;
  /** Ordered, so a save reproduces the file's own order. */
  settings: Setting[];
  /** Normalized key to the same Setting objects held in `settings`, for O(1) lookup. */
  keys: Map<string, Setting>;
}

/**
 * The settings held in memory, in two views kept in step: `order` is the file's own order so
 * a save reproduces it, and `index` maps normalized names to the same objects for O(1)
 * lookup. Without the index every lookup is a linear scan, so walking a file's own sections
 * costs O(n²) — about a second for 4,000 sections. Every mutation goes through this class,
 * so neither view can change without the other.
 *
 * Lookups are lenient and never throw. Validating names is the caller's job.
 */
export class IniDocument {
  private readonly order: Section[] = [];
  private readonly index = new Map<string, Section>();

  constructor(private readonly caseInsensitive: boolean) {}

  /** A section name or key as it is compared: trimmed, and lowercased when case-insensitive. */
  private normalize(input: string): string {
    const trimmed = input.trim();
    return this.caseInsensitive ? trimmed.toLowerCase() : trimmed;
  }

  /**
   * normalize() for a lookup, which may be handed anything. A non-string matches nothing
   * rather than normalizing to "": that is a real section name — the nameless leading one —
   * and a caller passing undefined must not be handed its settings.
   */
  private lookupKey(input: unknown): string | null {
    return typeof input === "string" ? this.normalize(input) : null;
  }

  private findSection(name: string): Section | null {
    const normalized = this.lookupKey(name);
    return normalized === null ? null : this.index.get(normalized) ?? null;
  }

  private findSetting(section: string, key: string): Setting | null {
    const normalized = this.lookupKey(key);
    return normalized === null ? null : this.findSection(section)?.keys.get(normalized) ?? null;
  }

  /**
   * Returns the section, adding it at the end when it is new. A repeated name continues the
   * existing section rather than shadowing it.
   */
  private ensure(name: string): Section {
    const normalized = this.normalize(name);
    let section = this.index.get(normalized);
    if (!section) {
      section = { name, settings: [], keys: new Map() };
      this.order.push(section);
      this.index.set(normalized, section);
    }
    return section;
  }

  /** Adds an empty section unless one by that name is already there. */
  ensureSection(name: string): void {
    this.ensure(name);
  }

  /** Sets a value, adding the section and the key as needed. A key keeps its first spelling. */
  set(section: string, key: string, value: string): void {
    const target = this.ensure(section);
    const normalized = this.normalize(key);
    const existing = target.keys.get(normalized);
    if (existing) {
      existing.value = value;
      return;
    }
    const setting: Setting = { key, value };
    target.settings.push(setting);
    target.keys.set(normalized, setting);
  }

  get(section: string, key: string): string | null {
    return this.findSetting(section, key)?.value ?? null;
  }

  hasSection(section: string): boolean {
    return this.findSection(section) !== null;
  }

  hasKey(section: string, key: string): boolean {
    return this.findSetting(section, key) !== null;
  }

  sectionNames(): string[] {
    return this.order.map((section) => section.name);
  }

  keys(section: string): string[] {
    return this.findSection(section)?.settings.map((setting) => setting.key) ?? [];
  }

  removeSection(section: string): void {
    const target = this.findSection(section);
    if (!target) {
      return;
    }
    // Found, so `section` is a string.
    this.order.splice(this.order.indexOf(target), 1);
    this.index.delete(this.normalize(section));
  }

  removeKey(section: string, key: string): void {
    const target = this.findSection(section);
    const setting = this.findSetting(section, key);
    if (!target || !setting) {
      return;
    }
    // Found, so `key` is a string.
    target.settings.splice(target.settings.indexOf(setting), 1);
    target.keys.delete(this.normalize(key));
  }

  /** Every section in the file's own order, for rendering. */
  sections(): readonly IIniSectionView[] {
    return this.order;
  }
}
