/** Viewports the tab can emulate. Journeys default to a phone; `jevway_task` keeps the desktop viewport. */
export interface Device {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent?: string;
}

export const DEVICES = {
  desktop: { name: 'desktop', width: 1120, height: 780, deviceScaleFactor: 1, mobile: false },
  laptop: { name: 'laptop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  'iphone-15': {
    name: 'iphone-15',
    width: 393,
    height: 852,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-8': {
    name: 'pixel-8',
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
  },
} satisfies Record<string, Device>;

export type DeviceName = keyof typeof DEVICES;
