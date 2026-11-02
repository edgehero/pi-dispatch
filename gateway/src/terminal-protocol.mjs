/** Data-only transport bounds shared by the browser and runtime; this module imports no host capability. */
export const GATEWAY_LIMITS = Object.freeze({ connections: 32, bodyBytes: 2048, frameBytes: 65536, inputBytes: 16384, bytesPerSecond: 65536, framesPerSecond: 80, resizesPerSecond: 10, activityPerSecond: 2, bufferedBytes: 1048576, pollMs: 1000, timerMs: 100, upgradeMs: 5000, minimumWidth: 761, maxCols: 500, maxRows: 200 });

export function gatewayDimensions(cols, rows) {
	return Number.isInteger(cols) && cols >= 2 && cols <= GATEWAY_LIMITS.maxCols && Number.isInteger(rows) && rows >= 1 && rows <= GATEWAY_LIMITS.maxRows;
}
