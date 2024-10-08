[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fini-file-cache%2Fmain%2Fpackage.json&query=%24.version&prefix=v&label=npm&color=blue)](https://www.npmjs.com/package/@mdaemon/ini-file-cache) [![Static Badge](https://img.shields.io/badge/node-v16%2B-blue?style=flat&label=node&color=blue)](https://nodejs.org) [![install size](https://packagephobia.com/badge?p=@mdaemon/ini-file-cache)](https://packagephobia.com/result?p=@mdaemon/ini-file-cache) [![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fini-file-cache%2Fmain%2Fpackage.json&query=%24.license&prefix=v&label=license&color=green)](https://github.com/mdaemon-technologies/ini-file-cache/blob/main/LICENSE) [![Node.js CI](https://github.com/mdaemon-technologies/ini-file-cache/actions/workflows/node.js.yml/badge.svg)](https://github.com/mdaemon-technologies/ini-file-cache/actions/workflows/node.js.yml)

# @mdaemon/ini-file-cache, A library for reading, writing, and watching ini files for changes

 Not applicable to a browser context.

# Install #

    $ npm install @mdaemon/ini-file-cache --save

# Node CommonJS #
```javascript
   const IniFileCache = require("@mdaemon/ini-file-cache");
```
# Node Modules #
```javascript
   import IniFileCache from "@mdaemon/ini-file-cache";
```
### IniFileCache ###

```javascript
// Create a new IniFileCache instance
const iniCache = new IniFileCache("/path/to/file/", "config.ini");

// Read a value from the ini file
const value = iniCache.get("section", "key", "defaultValue");
console.log(value);

// Write a value to the ini file
iniCache.set("section", "key", "new value");

// Save changes to the file
iniCache.save();

// Watch for changes in the ini file
iniCache.watch();

// Stop watching the file
iniCache.unwatch();

// Get all sections
const sections = iniCache.getSections();
console.log(sections);

// Get all keys in a section
const keys = iniCache.getKeys("section");
console.log(keys);

// Check if a section exists
const sectionExists = iniCache.hasSection("section");
console.log(sectionExists);

// Check if a key exists in a section
const keyExists = iniCache.hasKey("section", "key");
console.log(keyExists);

// Remove a key from a section
iniCache.removeKey("section", "key");

// Remove an entire section
iniCache.removeSection("section");

// Reload the file from disk
iniCache.reload();

iniCahe.listener.on("change", (filename) => { });

iniCache.listener.on("error", (error) => { });

iniCache.listener.on("reload", (filePath) => { });

iniCache.listener.on("save", (filePath) => { });

```

# License #

Published under the [LGPL-2.1 license](https://github.com/mdaemon-technologies/ini-file-cache/blob/main/LICENSE "LGPL-2.1 License").

Published by<br/> 
<b>MDaemon Technologies, Ltd.<br/>
Simple Secure Email</b><br/>
[https://www.mdaemon.com](https://www.mdaemon.com)