import * as webpush from "npm:web-push@4.0.0";
import { createNotifyHandler } from "./handler.ts";

Deno.serve(
  createNotifyHandler({
    env: (key) => Deno.env.get(key),
    fetch,
    push: webpush,
  }),
);
