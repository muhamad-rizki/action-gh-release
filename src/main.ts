import {
  paths,
  parseConfig,
  isTag,
  unmatchedPatterns,
  uploadUrl,
} from "./util";
import { release, upload, GitHubReleaser } from "./github";
import { getOctokit } from "@actions/github";
import { setFailed, setOutput } from "@actions/core";

import { env } from "process";

async function run() {
  try {
    const config = parseConfig(env);
    if (
      !config.input_tag_name &&
      !isTag(config.github_ref) &&
      !config.input_draft
    ) {
      throw new Error(`⚠️ GitHub Releases requires a tag`);
    }
    if (config.input_files) {
      const patterns = unmatchedPatterns(config.input_files);
      patterns.forEach((pattern) => {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(`⚠️  Pattern '${pattern}' does not match any files.`);
        } else {
          console.warn(`🤔 Pattern '${pattern}' does not match any files.`);
        }
      });
      if (patterns.length > 0 && config.input_fail_on_unmatched_files) {
        throw new Error(`⚠️ There were unmatched files`);
      }
    }

    // const oktokit = GitHub.plugin(
    //   require("@octokit/plugin-throttling"),
    //   require("@octokit/plugin-retry")
    // );

    const hasProxy =
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy;
    const fetchApi =
      !hasProxy && typeof globalThis.fetch === "function"
        ? (url: any, opts: any) => globalThis.fetch(url, opts)
        : undefined;

    const gh = getOctokit(config.github_token, {
      ...(fetchApi ? { request: { fetch: fetchApi } } : {}),
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`,
          );
          if (options.request.retryCount === 0) {
            // only retries once
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter, options) => {
          // does not retry, only logs a warning
          console.warn(
            `Abuse detected for request ${options.method} ${options.url}`,
          );
        },
      },
    });
    //);
    const rel = await release(config, new GitHubReleaser(gh));
    if (config.input_files && config.input_files.length > 0) {
      const files = paths(config.input_files);
      if (files.length == 0) {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(
            `⚠️ ${config.input_files} does not include a valid file.`,
          );
        } else {
          console.warn(
            `🤔 ${config.input_files} does not include a valid file.`,
          );
        }
      }
      const currentAssets = rel.assets;

      const uploadFile = async (path) => {
        const json = await upload(
          config,
          gh,
          uploadUrl(rel.upload_url),
          path,
          currentAssets,
        );
        delete json.uploader;
        return json;
      };

      let results: PromiseSettledResult<any>[];
      if (!config.input_preserve_order) {
        results = await Promise.allSettled(files.map(uploadFile));
      } else {
        results = [];
        for (const path of files) {
          try {
            const asset = await uploadFile(path);
            results.push({ status: "fulfilled", value: asset });
          } catch (reason) {
            results.push({ status: "rejected", reason });
          }
        }
      }

      const assets: any[] = [];
      const failedUploads: string[] = [];

      results.forEach((result, index) => {
        const filePath = files[index];
        if (result.status === "fulfilled") {
          assets.push(result.value);
        } else {
          const reason = result.reason;
          const errorMessage =
            reason instanceof Error ? reason.message : String(reason);
          console.error(
            `❌ Failed to upload asset '${filePath}': ${errorMessage}`,
          );
          failedUploads.push(`'${filePath}': ${errorMessage}`);
        }
      });

      setOutput("assets", assets);

      if (failedUploads.length > 0) {
        throw new Error(
          `⚠️ Failed to upload ${failedUploads.length} release asset(s):\n` +
            failedUploads.map((err) => `  - ${err}`).join("\n"),
        );
      }
    }
    console.log(`🎉 Release ready at ${rel.html_url}`);
    setOutput("url", rel.html_url);
    setOutput("id", rel.id.toString());
    setOutput("upload_url", rel.upload_url);
  } catch (error) {
    setFailed(error.message);
  }
}

run();
