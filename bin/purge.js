#!/usr/bin/env node

"use strict";

var async = require("async"),
    env = require("require-env"),
    knox = require("knox");

var client = knox.createClient({
  key: env.require("AWS_ACCESS_KEY_ID"),
  secret: env.require("AWS_SECRET_ACCESS_KEY"),
  bucket: env.require("S3_BUCKET")
});

var PATH_PREFIX = process.env.PATH_PREFIX || "";

// remove a leading slash if necessary
if (PATH_PREFIX && PATH_PREFIX.indexOf("/") === 0) {
  PATH_PREFIX = PATH_PREFIX.slice(1);
}

var count,
    deletedKeyCount = 0,
    marker;

async.doWhilst(
  function(next) {
    return client.list({
      // delimiter: "/",
      marker: marker || "",
      prefix: PATH_PREFIX
    }, function(err, data) {
      if (err) {
        return next(err);
      }

      var keys = data.Contents.map(function(x) {
        return x.Key;
      });

      count = keys.length;
      marker = data.Marker;

      return client.deleteMultiple(keys, function(err) {
        process.stdout.write(".");
        deletedKeyCount += keys.length;

        return next(err);
      });
    });
  },
  function() { return count > 0; },
  function(err) {
    if (err) {
      console.error(err);
    }

    console.log("Deleted %d keys.", deletedKeyCount);
  });

setInterval(function() {
  console.log("Deleted %d keys.", deletedKeyCount);
}, 10000).unref();
