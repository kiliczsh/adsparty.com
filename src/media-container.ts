import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
export class MediaPackager extends Container {
  defaultPort = 8080;
  sleepAfter = "10s";
  envVars = {
    PACKAGER_TOKEN:
      (env as unknown as { PACKAGER_TOKEN?: string }).PACKAGER_TOKEN || "",
    PACKAGER_SOURCE_HOSTS: ".fal.media,.wiro.ai",
  };
}
