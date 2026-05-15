import { envsafe, str, port } from "envsafe";

export const env = envsafe({
  DATABASE_URL: str(),
  API_KEY: str(),
  PORT: port({ default: 3000 }),
});
