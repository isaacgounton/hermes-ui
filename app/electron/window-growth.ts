// Web build: type-only shim for upstream electron/window-growth.ts (that module
// resizes the Electron BrowserWindow). Keep in step with upstream's GrowRequest.
export interface GrowRequest {
  bottom?: number
  left?: number
  /** Floor for the resulting viewport width in CSS pixels, used to clear a responsive breakpoint. */
  minWidth?: number
  right?: number
  top?: number
}
