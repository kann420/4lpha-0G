import { globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "artifacts/**", "build/**", "cache/**", "next-env.d.ts", "out/**"]),
];

export default eslintConfig;
