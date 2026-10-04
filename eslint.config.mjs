import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });
const eslintConfig = [...compat.extends("next/core-web-vitals", "next/typescript")];
const projectConfig = [{ ignores: [".next/**", "node_modules/**", "next-env.d.ts"] }, ...eslintConfig];
export default projectConfig;
