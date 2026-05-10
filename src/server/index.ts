import { buildApp } from "./app";
import { config } from "./config";

const app = await buildApp();

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
