interface WatchEnv {
  ORIGIN: Fetcher;
}

export default {
  fetch(request: Request, env: WatchEnv) {
    return env.ORIGIN.fetch(request);
  },
} satisfies ExportedHandler<WatchEnv>;
