"use strict";

var async = require("async"),
    env = require("require-env"),
    knox = require("knox");

var client = knox.createClient({
  key: env.require("AWS_ACCESS_KEY_ID"),
  secret: env.require("AWS_SECRET_ACCESS_KEY"),
  bucket: env.require("S3_BUCKET")
});

var count,
    deletedKeyCount = 0;

async.doWhilst(
  function(next) {
    return client.list(function(err, data) {
      if (err) {
        return next(err);
      }

      var keys = data.Contents.map(function(x) {
        return x.Key;
      });

      count = keys.length;

      return client.deleteMultiple(keys, function(err) {
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

