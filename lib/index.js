"use strict";

var assert = require("assert"),
    url = require("url"),
    util = require("util");

var metricsd = require("metricsd"),
    request = require("request");

var metrics = metricsd({
  log: !process.env.DISABLE_METRICS
});

var AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    S3_BUCKET,
    S3_URL,
    ORIGIN,
    CACHE_EVERYTHING;

module.exports = function(options) {
  AWS_ACCESS_KEY_ID = options.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  AWS_SECRET_ACCESS_KEY= options.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  S3_BUCKET = options.S3_BUCKET || process.env.S3_BUCKET;
  S3_URL = options.S3_URL || process.env.S3_URL || "http://s3.amazonaws.com";
  ORIGIN = options.ORIGIN || process.env.ORIGIN;
  CACHE_EVERYTHING = options.CACHE_EVERYTHING === undefined ? !!process.env.CACHE_EVERYTHING : options.CACHE_EVERYTHING;

  return {
    isCacheable: isCacheable,
    fetchAndStore: fetchAndStore,
    populateHeaders: populateHeaders,
    populateS3Headers: populateS3Headers
  };
};

var populateHeaders = function(sourceHeaders) {
  var headers = {};

  if (sourceHeaders["user-agent"]) {
    headers["User-Agent"] = sourceHeaders["user-agent"];
  }

  if (sourceHeaders["referer"]) {
    headers["Referer"] = sourceHeaders["referer"];
  }

  return headers;
};

var populateS3Headers = function(sourceHeaders) {
  var headers = {
    "x-amz-acl": "public-read",
    "Content-Type": sourceHeaders["content-type"]
  };

  if (sourceHeaders["cache-control"]) {
    headers["Cache-Control"] = sourceHeaders["cache-control"];
  }

  return headers;
};

var isCacheable = function(rsp) {
  // (max-age=0 probably means that the tile is corrupt)
  return rsp.statusCode === 200 &&
    (CACHE_EVERYTHING ||
      (rsp.headers["cache-control"] &&
        rsp.headers["cache-control"].indexOf("max-age=0") < 0));
};

var fetchAndStore = function(path, headers, callback) {
  // TODO use ultrafuge's getTile trick with an LRU cache to prevent thundering
  // herds
  assert.ok(ORIGIN, "ORIGIN must be set.");
  assert.ok(AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID must be set.");
  assert.ok(AWS_SECRET_ACCESS_KEY, "AWS_SECRET_ACCESS_KEY must be set.");
  assert.ok(S3_BUCKET, "S3_BUCKET must be set.");
  assert.ok(S3_URL, "S3_URL must be set.");

  return request.get({
    url: ORIGIN + path,
    encoding: null,
    headers: populateHeaders(headers)
  }, function(err, rsp, body) {
    if (err) {
      console.warn("Failed while making upstream request:", err);
      return callback(err);
    }

    if (CACHE_EVERYTHING) {
      rsp.headers["cache-control"] = rsp.headers["cache-control"] || "public,max-age=300";
    }

    // pass data before storing in S3
    callback(err, rsp, body);

    // only write the file if it's cacheable
    if (isCacheable(rsp) &&
        path !== '/' &&
        !url.parse(path).query) {
      // pipe it into S3
      request.put({
        url: util.format("%s/%s%s", S3_URL, S3_BUCKET, path),
        body: body,
        aws: {
          key: AWS_ACCESS_KEY_ID,
          secret: AWS_SECRET_ACCESS_KEY
        },
        headers: populateS3Headers(rsp.headers),
        agentOptions: {
          maxSockets: 1024
        }
      }, function(err, rsp, body) {
        if (err || rsp.statusCode !== 200) {
          console.warn("Failed while writing %s to S3:", path, err || rsp.statusCode);

          if (body) {
            console.warn(body);
          }

          return;
        }

        metrics.mark("store");
        // console.log("%s successfully uploaded to %s.", path, S3_BUCKET);
      });

      return;
    }
  });
};
