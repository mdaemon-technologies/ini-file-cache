import { IniDocument } from "./document";

/**
 * How the file was laid out, kept so that a save reproduces it rather than silently
 * rewriting the encoding marker or the line endings of an existing file.
 */
export interface IIniLayout {
  /**
   * The exact bytes of the byte order mark to write, or null for none. Kept as bytes rather
   * than as a character: re-encoding U+FEFF would emit the wrong ones for any encoding other
   * than the file's own.
   */
  readonly byteOrderMark: Buffer | null;
  readonly endOfLine: string;
  /**
   * Whether the nameless leading section came from a literal "[]" header rather than from
   * bare keys, so that a save reproduces the file it read.
   */
  readonly namelessHasHeader: boolean;
}

export interface IParsedIni {
  document: IniDocument;
  /** The content began with U+FEFF, which has been stripped. */
  byteOrderMark: boolean;
  /** The content's first line break, or null when it has none. */
  endOfLine: string | null;
  namelessHasHeader: boolean;
}

// U+FEFF. Derived from the code point rather than written as the literal character, which
// is invisible in an editor and is easily mangled by a re-save under another encoding.
const BYTE_ORDER_MARK_CODE = 0xfeff;
export const BYTE_ORDER_MARK = String.fromCharCode(BYTE_ORDER_MARK_CODE);

// A section name is terminated by "]", so it may not contain one. Line breaks and null
// characters would let a crafted value forge additional lines on save.
const INVALID_SECTION = /[\r\n\0\]]/;
// A key is terminated by "=", so it may not contain one.
const INVALID_KEY = /[\r\n\0=]/;
// A key starting with a comment marker would be read back as a comment and disappear.
const COMMENT_START = /^[;#]/;
const INVALID_VALUE = /[\r\n\0]/;

// Matches the line endings of any platform, and of a file that mixes them.
const LINE_BREAK = /\r\n|\n|\r/;
const SECTION_HEADER = /^\[([^\]]*)\]\s*(?:[;#].*)?$/;

/**
 * Parses ini text into a new document without touching anything else. Resolves null when the
 * text has settings but not one header in the whole file: far more likely a truncated read
 * than an ini file, and adopting it would let the next save write that damage to disk.
 */
export function parseIni(contents: string, caseInsensitive: boolean): IParsedIni | null {
  const byteOrderMark = contents.charCodeAt(0) === BYTE_ORDER_MARK_CODE;
  const body = byteOrderMark ? contents.slice(1) : contents;
  const firstLineBreak = LINE_BREAK.exec(body);

  const document = new IniDocument(caseInsensitive);
  let currentSection: string | null = null;
  let sawContentOutsideSection = false;
  let sawSectionHeader = false;
  let namelessHasHeader = false;

  for (const line of body.split(LINE_BREAK)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || COMMENT_START.test(trimmedLine)) {
      // Blank lines and comments carry no settings.
      continue;
    }

    const header = SECTION_HEADER.exec(trimmedLine);
    if (header) {
      const name = header[1].trim();
      sawSectionHeader = true;
      if (name === "") {
        // Recorded for every "[]" header, not only one that creates the section: leading
        // bare keys may have created it already, and the header would then be dropped.
        namelessHasHeader = true;
      }
      // A repeated header continues the existing section rather than shadowing it.
      document.ensureSection(name);
      currentSection = name;
      continue;
    }

    if (currentSection === null) {
      // Settings before any header belong to a nameless leading section, kept so that a
      // save does not erase the part of the file this parser did not ask for. Added here
      // rather than with the first key, which may yet turn out to be empty.
      sawContentOutsideSection = true;
      currentSection = "";
      document.ensureSection(currentSection);
    }

    // Split on the first "=" only, so values may contain "=" themselves.
    const separator = trimmedLine.indexOf("=");
    const key = (separator === -1 ? trimmedLine : trimmedLine.slice(0, separator)).trim();
    if (!key) {
      continue;
    }
    const value = separator === -1 ? "" : trimmedLine.slice(separator + 1).trim();
    document.set(currentSection, key, value);
  }

  if (sawContentOutsideSection && !sawSectionHeader) {
    return null;
  }
  return { document, byteOrderMark, endOfLine: firstLineBreak ? firstLineBreak[0] : null, namelessHasHeader };
}

/** Renders a document as ini text, without the byte order mark, which is written as bytes. */
export function serializeIni(document: IniDocument, layout: IIniLayout): string {
  const eol = layout.endOfLine;
  const sections = document.sections();
  let contents = "";
  sections.forEach((section, index) => {
    // The nameless section may only go without a header while it leads the file and some
    // other section follows it: anywhere else its keys would be read back as part of the
    // section above, and on its own the file would have no header at all and so would not
    // parse.
    const bare = section.name === "" && index === 0 && !layout.namelessHasHeader && sections.length > 1;
    if (bare && !section.settings.length) {
      // Nothing to write, and a stray blank line here would break save/reload equality.
      return;
    }
    if (!bare) {
      contents += `[${section.name}]${eol}`;
    }
    for (const setting of section.settings) {
      contents += `${setting.key}=${setting.value}${eol}`;
    }
    contents += eol;
  });
  return contents;
}

function sanitizeName(input: string, label: string, invalid: RegExp): string {
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (invalid.test(trimmed)) {
    throw new TypeError(`${label} "${input}" contains characters that are not valid in an ini file`);
  }
  return trimmed;
}

/**
 * Validates a section name. "" — or only whitespace — addresses the nameless leading
 * section, the one holding keys that appear before any header.
 */
export function sanitizeSection(section: string): string {
  if (typeof section === "string" && !section.trim()) {
    return "";
  }
  return sanitizeName(section, "section", INVALID_SECTION);
}

/**
 * Validates a key against the characters that would forge structure on the next read. This
 * is an ini-injection guard, not cosmetic validation.
 */
export function sanitizeKey(key: string): string {
  const trimmed = sanitizeName(key, "key", INVALID_KEY);
  if (COMMENT_START.test(trimmed)) {
    throw new TypeError(`key "${key}" must not start with ";" or "#", which would be read back as a comment`);
  }
  if (trimmed.startsWith("[")) {
    // "[a] ;x=v" satisfies the section header pattern, so such a key would come back as a
    // section and take its setting with it.
    throw new TypeError(`key "${key}" must not start with "[", which could be read back as a section header`);
  }
  return trimmed;
}

export function sanitizeValue(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }
  if (INVALID_VALUE.test(value)) {
    throw new TypeError("value must not contain line breaks or null characters");
  }
  return value.trim();
}
