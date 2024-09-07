import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import * as util from "../../util.mjs";
import { wrap_obj, run_script, convert_url } from "../context.mjs";

export function fakeImportScripts(...paths) {
  let script_urls = paths.map((path) => convert_url(path, loader.url));
  console.log("DEBUG importScripts", network.requests_allowed, script_urls)

  //requests are allowed, we are running as the real worker  
  if (network.requests_allowed) {
    for (let url of script_urls) {
      if (typeof network.resource_cache[url] === "string") {
        run_script(network.resource_cache[url]);
      }
      else if (network.resource_cache[url] === false) {
        throw Error("Script network request failed");
      }
      else {
        //cache miss - try to load the script async anyways
        console.warn("WARN importScripts cache miss for", url);
        network.fetch(url).then(r => r.text()).then(run_script)
      }
    }
  }
  //otherwise just log the url that was fetched
  else {
    rpc.parent.postMessage({
      frame_id: loader.frame_id,
      urls: script_urls
    })
  }
}

export class FakeWorker extends EventTarget {
  #url; #options; #worker; #msg_queue; #terminated;

  constructor(url, options) {
    console.log("DEBUG new Worker", url, options);
    super();
    this.#url = url;
    this.#options = options;
    this.#worker = null;
    this.#msg_queue = [];
    this.#terminated = false;

    this.onerror = () => {};
    this.onmessage = () => {};
    this.onmessageerror = () => {};

    this.#load_worker();
  }

  async #load_worker() {
    let response = await network.fetch(this.#url);
    let worker_js = JSON.stringify(await response.text());
    let worker_id = "" + Math.random();
    let temp_script = `
      ${loader.runtime_src}
      proxy_frame.loader.set_url("${loader.url}");
      proxy_frame.loader.set_frame_id("${worker_id}");
      proxy_frame.context.update_ctx();
      proxy_frame.context.run_script(${worker_js});
    `;
    let temp_blob = new Blob([temp_script], {type: "text/javascript"});
    let temp_blob_url = URL.createObjectURL(temp_blob);

    if (this.#terminated) return;
    let temp_worker = new Worker(temp_blob_url, this.#options);
    let recorded_urls = [];
    let terminate_worker;
    temp_worker.onmessage = (event) => {
      if (event.data.frame_id !== worker_id) return;
      recorded_urls = recorded_urls.concat(recorded_urls, event.data.urls);
    }
    temp_worker.onerror = () => {
      terminate_worker();
    }

    //wait for the temp worker to record the imported URLs, then kill it
    await new Promise((resolve) => {
      terminate_worker = resolve;
      setTimeout(resolve, 500);
    });
    temp_worker.terminate();

    //fetch all of the imported URLs
    let promises = [];
    let script_data = {};
    for (let url of recorded_urls) {
      script_data[url] = false;
      promises.push((async () => {
        let response = await network.fetch(url);
        let script_text = await response.text();
        script_data[url] = script_text;
      })());
    }
    await util.run_parallel(promises);

    let cache_puts = [];
    for (let url of recorded_urls) {
      let safe_url = JSON.stringify(url);
      let safe_contents = JSON.stringify(script_data[url]);
      cache_puts.push(`proxy_frame.network.cache_put(${safe_url}, ${safe_contents});`);
    }
    let cache_substr = cache_puts.join("\n");
    let real_script = `
      ${loader.runtime_src}
      ${cache_substr}
      proxy_frame.loader.set_url(${JSON.stringify(loader.url)});
      proxy_frame.loader.set_frame_id("${worker_id}");
      proxy_frame.network.enable_network();
      proxy_frame.context.update_ctx();
      proxy_frame.context.run_script("console.log(self)");
      proxy_frame.context.run_script(${worker_js});
    `;
    let real_blob = new Blob([real_script], {type: "text/javascript"});
    let real_blob_url = network.create_blob_url(real_blob, this.#url);

    this.#worker = new Worker(real_blob_url, this.#options);
    for (let event of ["error", "message", "messageerror"]) {
      this.#setup_listener(event);
    }
  }

  #setup_listener(event_name) {
    this.#worker.addEventListener(event_name, (event) => {
      this["on" + event_name](event);
      let new_event = new event.constructor(event_name);
      wrap_obj(event, new_event);
      this.dispatchEvent(new_event);
    })
  }

  postMessage(message, transfer) {
    if (this.#worker == null) 
      this.#msg_queue.push([message, transfer]);
    else
      this.#worker.postMessage(message, transfer)
  }

  terminate() {
    this.#worker.terminate();
    this.#terminated = true;
  }
}