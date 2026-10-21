/** The command's name and version, from package.json (scripts/cli-name.mjs; vitest.config.ts for the tests). */
declare const __CLI_NAME__: string;
declare const __CLI_VERSION__: string;
/** Fingerprint of the sources the bundle was built from (scripts/source-hash.mjs). */
declare const __SOURCE_HASH__: string;
/** Pages bundled as text (esbuild loader "text"): src/web/index.html for the web service. */
declare module '*.html' {
  const text: string;
  export default text;
}
