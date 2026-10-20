import { getIDBClient } from './idb-client.js'
import type { ScanRegion, ScanCommand, UIElement } from '../types.js'

export function regionToCommand(
  region: ScanRegion,
  screenWidth: number,
  screenHeight: number,
  gridStep: number,
): ScanCommand {
  const midX = Math.round(screenWidth / 2)
  const midY = Math.round(screenHeight / 2)
  const pad = Math.round(gridStep / 2)

  switch (region) {
    case 'full':
      return { grid_step: gridStep, x_start: pad, y_start: pad, x_end: screenWidth, y_end: screenHeight }
    case 'top-half':
      return { grid_step: gridStep, x_start: pad, y_start: pad, x_end: screenWidth, y_end: midY }
    case 'bottom-half':
      return { grid_step: gridStep, x_start: pad, y_start: midY, x_end: screenWidth, y_end: screenHeight }
    case 'top-left':
      return { grid_step: gridStep, x_start: pad, y_start: pad, x_end: midX, y_end: midY }
    case 'top-right':
      return { grid_step: gridStep, x_start: midX, y_start: pad, x_end: screenWidth, y_end: midY }
    case 'bottom-left':
      return { grid_step: gridStep, x_start: pad, y_start: midY, x_end: midX, y_end: screenHeight }
    case 'bottom-right':
      return { grid_step: gridStep, x_start: midX, y_start: midY, x_end: screenWidth, y_end: screenHeight }
  }
}

// Use the same pinned companion and bounded requests as input. The old native
// scanner links legacy IDB frameworks and can hang before READY on new Xcode.
export class AXScanClient {
  private static instances = new Map<string, AXScanClient>()
  private constructor(private udid: string) {}
  static getInstance(udid: string): AXScanClient {
    if (!this.instances.has(udid)) this.instances.set(udid, new AXScanClient(udid))
    return this.instances.get(udid)!
  }
  async getScreenSize(): Promise<{width: number; height: number}> {
    return getIDBClient(this.udid).getScreenSize()
  }
  async scan(region: ScanRegion, gridStep = 25): Promise<unknown[]> {
    const client = getIDBClient(this.udid)
    const raw = await client.describeAll(false)
    const elements = Array.isArray(raw) ? raw : [raw]
    if (region === 'full') return elements
    const { width, height } = await this.getScreenSize()
    const bounds = regionToCommand(region, width, height, 0)
    return elements.filter((element: UIElement) => {
      const frame = element.frame
      if (!frame) return false
      const x = frame.x + frame.width / 2, y = frame.y + frame.height / 2
      return x >= bounds.x_start && x <= bounds.x_end && y >= bounds.y_start && y <= bounds.y_end
    })
  }
  async shutdown(): Promise<void> { AXScanClient.instances.delete(this.udid) }
  static async shutdownAll(): Promise<void> { AXScanClient.instances.clear() }
}
