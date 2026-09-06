import { canLogin } from "./login.js";

if (canLogin("fallback-token")) throw new Error("seed bug: fallback token accepted");
