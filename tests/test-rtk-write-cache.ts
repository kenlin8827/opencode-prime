import { createRewriteCache } from "../plugins/rtk-write/index";

let calls = 0;
const rewrite = createRewriteCache(async (command) => {
  calls++;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return command === "git status" ? "rtk git status" : null;
});

const [first, second] = await Promise.all([
  rewrite("git status"),
  rewrite("git status"),
]);
const third = await rewrite("git status");
if (
  first !== "rtk git status" ||
  second !== "rtk git status" ||
  third !== "rtk git status" ||
  calls !== 1
) {
  throw new Error(
    `cache failed: first=${first}, second=${second}, third=${third}, calls=${calls}`,
  );
}
console.log("OK   duplicate rewrites use one RTK process");
