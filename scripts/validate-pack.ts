import { readFileSync } from "node:fs";
import { RecoveryPackSchema } from "../src/recorder/compile.js";
const p = RecoveryPackSchema.parse(
  JSON.parse(readFileSync("config/recovery-pack.corevantage-backoffice.json", "utf8")),
);
console.log("pack valid:", p.vendorProduct, "|", p.knownOutcomes.length, "outcomes,", p.recoveries.length, "recoveries");
console.log("business:   ", p.knownOutcomes.filter((o) => o.severity === "business").map((o) => o.code).join(", "));
console.log("recoverable:", p.knownOutcomes.filter((o) => o.severity === "recoverable").map((o) => o.code).join(", "));
console.log("hard:       ", p.knownOutcomes.filter((o) => o.severity === "hard").map((o) => o.code).join(", "));
