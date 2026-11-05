// tells the game it's the desktop app (and how many cores it has), and gives photo mode a real save dialog
const {contextBridge,ipcRenderer}=require('electron');const os=require('os');
contextBridge.exposeInMainWorld('BAYSHORE_NATIVE',{app:'desktop',cores:os.cpus().length,info:()=>ipcRenderer.invoke('bayshore-info'),save:(filename,data)=>ipcRenderer.invoke('bayshore-save',{filename,data})});
