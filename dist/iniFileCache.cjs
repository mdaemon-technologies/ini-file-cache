"use strict";var t=require("fs"),e=require("path"),i=require("@mdaemon/emitter/dist/emitter.cjs");function s(t){var e=Object.create(null);return t&&Object.keys(t).forEach((function(i){if("default"!==i){var s=Object.getOwnPropertyDescriptor(t,i);Object.defineProperty(e,i,s.get?s:{enumerable:!0,get:function(){return t[i]}})}})),e.default=t,Object.freeze(e)}var n=s(t),r=s(e);function c(t){const e=r.join(r.dirname(t),".lck");n.existsSync(e)&&n.unlinkSync(e)}module.exports=class{constructor(t,e){this.cachePath=t,this.fileName=e,this.settings=[],this._listener=new i,this.file=r.join(this.cachePath,this.fileName),n.existsSync(this.cachePath)||n.mkdirSync(this.cachePath,{recursive:!0}),n.existsSync(this.file)||n.writeFileSync(this.file,""),this.cacheFileSettings(),this.watching=null,this.watch()}get listener(){return this._listener}parseContents(t){const e=t.split(/\r\n|\n|\r/),i=[];let s=null;for(const t of e){const e=t.trim();if(e.startsWith("[")&&e.endsWith("]")){s={name:e.slice(1,-1),settings:[]},i.push(s)}else if(e.startsWith(";")||e.startsWith("#"));else if(e&&s){const[t,i]=e.split("=");s.settings.push({key:t,value:i})}}if(e.length&&!s)return this.settings=[],void this.listener.emit("error",new Error("Invalid ini file format"));this.settings=i}async cacheFileSettings(){let t=0;await new Promise((e=>{for(;t<20;)try{const t=n.readFileSync(this.file,"utf8");return this.parseContents(t),void e(void 0)}catch(e){if(19===t)return void this.listener.emit("error",new Error(`Failed to read file after 20 attempts: ${e}`));t++,new Promise((t=>setTimeout(t,100)))}}))}getSetting(t,e,i=""){const s=this.settings.find((e=>e.name===t));if(!s)return i||null;const n=s.settings.find((t=>t.key===e));return n?n.value:i||null}setSetting(t,e,i){const s=this.settings.find((e=>e.name===t));if(!s)return void this.settings.push({name:t,settings:[{key:e,value:i}]});const n=s.settings.find((t=>t.key===e));n?n.value=i:s.settings.push({key:e,value:i})}getSections(){return this.settings.map((t=>t.name))}getKeys(t){const e=this.settings.find((e=>e.name===t));return e?e.settings.map((t=>t.key)):[]}hasSection(t){return this.settings.some((e=>e.name===t))}hasKey(t,e){const i=this.settings.find((e=>e.name===t));return!!i&&i.settings.some((t=>t.key===e))}removeSection(t){const e=this.settings.findIndex((e=>e.name===t));-1!==e&&this.settings.splice(e,1)}removeKey(t,e){const i=this.settings.find((e=>e.name===t));if(!i)return;const s=i.settings.findIndex((t=>t.key===e));-1!==s&&i.settings.splice(s,1)}async reload(){await this.cacheFileSettings(),this.listener.emit("reload",this.file)}async save(){let t="";for(const e of this.settings){t+=`[${e.name}]\n`;for(const i of e.settings)t+=`${i.key}=${i.value}\n`;t+="\n"}await async function(t){const e=r.join(r.dirname(t),".lck");let i=0;for(;n.existsSync(e)&&i<20;)await new Promise((t=>setTimeout(t,100))),i++;n.existsSync(e)||n.writeFileSync(e,"")}(this.file);try{n.writeFileSync(this.file,t,{flush:!0}),c(this.file),this.listener.emit("save",this.file)}catch(t){c(this.file),this.listener.emit("error",t)}}watch(){if(this.watching=n.watch(this.file,(async(t,e)=>{"change"===t&&(await this.cacheFileSettings(),this.listener.emit("change",e))})),this.watching)return this.watching.on("error",(t=>{this.listener.emit("error",t)})),void this.watching.once("close",(()=>{this.listener.emit("close")}));this.listener.emit("error",new Error("Failed to watch file"))}unwatch(){this.watching&&(n.unwatchFile(this.file),this.watching=null)}};
