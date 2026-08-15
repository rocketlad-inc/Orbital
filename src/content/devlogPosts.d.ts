// Types for the plain-JS seed module (it is plain JS so the worker can
// import it directly — see the header in devlogPosts.js).

export interface SeedPost {
  slug: string;
  title: string;
  date: string;
  lede: string;
  html: string;
  charts: boolean;
}

export const SEED_POSTS: SeedPost[];
