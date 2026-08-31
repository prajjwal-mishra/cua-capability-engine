import { createApp } from "./app.js";

const PORT = Number(process.env.LEGACY_CU_PORT ?? 4000);

createApp().listen(PORT, () => {
  console.log(`legacy-cu listening on http://localhost:${PORT}  (variant-a default)`);
  console.log(`  variant-b:  http://localhost:${PORT}/?variant=variant-b`);
});
