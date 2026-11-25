declare const __BUILD_VERSION__: string;

export const BUILD_VERSION = typeof __BUILD_VERSION__ === 'undefined' ? 'dev' : __BUILD_VERSION__;
