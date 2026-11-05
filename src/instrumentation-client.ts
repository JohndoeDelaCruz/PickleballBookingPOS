import { initializeLandingReload } from "@/lib/landing-startup";

// First-party initialization runs before hydration without adding a script
// element that can collide with browser-extension tags in the document head.
initializeLandingReload();
