declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare const IOUtils: {
  read: (path: string, options?: { maxBytes?: number }) => Promise<Uint8Array>;
  write: (path: string, data: Uint8Array) => Promise<void>;
  [key: string]: any;
};
