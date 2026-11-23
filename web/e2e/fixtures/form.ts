import type { Page } from "@playwright/test";
import { API } from "./contact";

// Cloudflare's dummy Turnstile behaviour, as a stand-in for its script: the
// widget "runs" when asked and calls back with the documented dummy token
// (made different each time so the API's stand-in accepts each once).
const WORKING = `(function(){
var n=0,w={};
window.turnstile={
render:function(c,o){var id="w"+(++n);w[id]=o;return id},
execute:function(id){var o=w[id];setTimeout(function(){o.callback("XXXX.DUMMY.TOKEN.XXXX#"+Date.now()+"-"+(++n))},10)},
reset:function(){},
remove:function(id){delete w[id]}
};
})();`;

const FAILING = WORKING.replace(
  'o.callback("XXXX.DUMMY.TOKEN.XXXX#"+Date.now()+"-"+(++n))',
  'o["error-callback"]()',
);

/** Answer Turnstile's script request with the stand-in. */
export async function stubTurnstile(
  page: Page,
  options: { fail?: boolean } = {},
) {
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js*",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: options.fail ? FAILING : WORKING,
      }),
  );
}

let counter = 0;

/**
 * Give each page its own client address, as Cloudflare would, so the API's
 * limit of five messages an hour for one address is not shared by every test.
 */
export async function withAddress(page: Page) {
  counter += 1;
  const address = `198.51.100.${((Date.now() + counter * 7) % 250) + 1}`;
  await page.route(`${API}/api/v1/contact`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": address },
    }),
  );
}
