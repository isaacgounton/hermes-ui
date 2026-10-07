// Web build: type-only shim for upstream electron/machine-profile.ts (that module
// reads the OS via node/electron). Keep in step with upstream's MachineProfile.
export interface MachineProfile {
  ageDays: number | null
  arch: string
  locale: string
  model: string
  nvidia: boolean
  platform: NodeJS.Platform
  release: string
  username: string
}
