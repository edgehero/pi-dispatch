const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
	const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
	window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
