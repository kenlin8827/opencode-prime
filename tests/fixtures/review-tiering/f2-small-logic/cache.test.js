import { clear, get, put } from "./cache.js";

clear();
put("user:1", { id: 1 }, 1000);
if (get("user:1")?.id !== 1) throw new Error("cache miss");
if (get("missing") !== undefined) throw new Error("unexpected cache hit");
clear();
