// Minimal ambient declaration for libmime — upstream ships no .d.ts files
// and @types/libmime does not exist. We only use a tiny subset of the API
// (header encoding) so a structural any is sufficient and keeps strict TS
// happy without adding a runtime dep.

declare module "libmime" {
  const libmime: {
    encodeWord(value: string, mimeWordEncoding?: "Q" | "B"): string;
    encodeWords(value: string, mimeWordEncoding?: "Q" | "B", maxLength?: number): string;
    decodeWords(value: string): string;
    foldLines(line: string, lineLengthMax?: number, afterSpace?: boolean): string;
    [key: string]: unknown;
  };
  export default libmime;
}
