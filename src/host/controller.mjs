import * as rpc from "../rpc.mjs";
import * as util from "../util.mjs";
import * as network from "./network.mjs";

import { version } from "./index.mjs";

import { libcurl } from "libcurl.js/bundled";

//frame_js is a string, which is imported using webpack
import frame_js from "../../dist/sandstone_frame.js";

let frame_url = null;
let frame_html = `
  <!DOCTYPE html>
  <head>
    <script>${frame_js}</script>
    <style>
      html {
        background-color: #222222;
        font-family: sans-serif;
      }
      * {
        color: #dddddd;
      }
      #error_div {
        display: none;
      }
      #version_text {
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <p id="loading_text">Loading...</p>

    <div id="error_div">
      <h2>An unexpected error has occurred</h2>
      <pre id="error_msg">
      </pre>
      <p><i>
        <span id="version_text"></span>
      </p></i>
    </div>
  </body>
`;

export const iframes = {};
export const persist_storage_key = "proxy_local_storage";
export let local_storage = {};

function get_frame_bundle() {
  if (!frame_url) {
    let frame_blob = new Blob([frame_html], {type: "text/html"});
    frame_url = URL.createObjectURL(frame_blob);
  }
  return frame_url;
}

export class ProxyFrame {
  constructor(iframe) {
    this.url = null;
    this.id = Math.random() + "";
    this.iframe = iframe;
    this.iframe.sandbox = "allow-scripts allow-forms allow-modals allow-pointer-lock";
    this.iframe.setAttribute("sandstone-id", this.id);

    iframes[this.id] = this;
    this.send_page = rpc.create_rpc_wrapper(this.iframe, "html");
    this.get_favicon = rpc.create_rpc_wrapper(this.iframe, "favicon");
    this.eval_js = rpc.create_rpc_wrapper(this.iframe, "eval");

    this.on_navigate = () => {};
    this.on_load = () => {};
    this.on_url_change = () => {};
  }

  async wait_for_libcurl() {
    if (libcurl.ready) return;
    await libcurl.load_wasm();
  }

  async navigate_to(url) {
    await this.wait_for_libcurl();
    if (!util.is_valid_url(url)) {
      throw TypeError("Invalid URL");
    }

    console.log("navigating to", url);
    this.url = new URL(url);
    this.iframe.style.backgroundColor = "#222222";
    this.on_navigate();
    this.iframe.src = get_frame_bundle();
    network.clean_ws_connections(this.id);

    let wait_for_load = () => {
      new Promise((resolve) => {
        this.iframe.onload = () => {
          resolve();
        }
      })
    }
    let download_html = async () => {
      try {
        let response = await libcurl.fetch(url);
        return [false, await response.text(), response.url];  
      }
      catch (error) {
        let error_msg = util.format_error(error);
        return [error_msg, null, url];
      }
    }

    let [error, html, final_url] = (await Promise.all([
      wait_for_load(),
      download_html()
    ]))[1];

    //load persisted local storage if needed
    if (!local_storage && window.origin) {
      local_storage = JSON.parse(localStorage.getItem(persist_storage_key));
    }

    this.url = new URL(final_url);
    try {
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        error: error,
        local_storage: local_storage[this.url.origin],
        version: version
      });
    }
    catch (error) {
      let error_msg = util.format_error(error);
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        error: error_msg,
        local_storage: undefined,
        version: version
      });
    }
    this.iframe.style.backgroundColor = "unset";
    this.on_load();
  }
}

rpc.rpc_handlers["navigate"] = async (frame_id, url, reload=true) => {
  let frame = iframes[frame_id];
  if (!frame) return;

  if (reload) {
    await frame.navigate_to(url);
  }
  else {
    frame.url = new URL(url);
    frame.on_url_change();
  }
}

rpc.rpc_handlers["local_storage"] = async (frame_id, entries) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  if (!frame.url.origin) debugger;
  local_storage[frame.url.origin] = entries;
  if (window.origin) {
    localStorage.setItem(persist_storage_key, JSON.stringify(local_storage));
  }
}