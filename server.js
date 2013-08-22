"use strict";

var http = require("http"),
    util = require("util");

var env = require("require-env"),
    express = require("express"),
    request = require("request"),
    toobusy = require("toobusy"),
    metricsd = require("metricsd");

var app = express(),
    metrics = metricsd({
      log: !process.env.DISABLE_METRICS
    });

//
// Configuration
//

var AWS_ACCESS_KEY_ID = env.require("AWS_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY = env.require("AWS_SECRET_ACCESS_KEY"),
    S3_BUCKET = env.require("S3_BUCKET"),
    ORIGIN = env.require("ORIGIN"),
    CACHE_EVERYTHING = !!process.env.CACHE_EVERYTHING;


// Express configuration
app.disable("x-powered-by");
app.use(express.responseTime());

app.configure("development", function() {
  app.use(express.logger());
});

http.globalAgent.maxSockets = 200;


//
// Timers
//

setInterval(function() {
  metrics.updateHistogram("lag", toobusy.lag());
}, 1000).unref();

//
// Utility functions
//

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

  if (CACHE_EVERYTHING) {
    headers["Cache-Control"] = "public,max-age=2592000";
  } else if (sourceHeaders["cache-control"]) {
    headers["Cache-Control"] = sourceHeaders["cache-control"];
  }

  return headers;
};

var isCacheable = function(rsp) {
  // (max-age=0 probably means that the tile is corrupt)
  return CACHE_EVERYTHING ||
         (rsp.headers["cache-control"] &&
            rsp.headers["cache-control"].indexOf("max-age=0") < 0);
};

//
// Routes
//

app.get("/favicon.ico", function(req, res) {
  res.send(404);
});

// catch-all route
app.use(function(req, res, next) {
  if (toobusy()) {
    // TODO extract the throttling code from sandwich-maker
    metrics.mark("busy");
  }

  var upstreamReq = request.get({
      url: ORIGIN + req.originalUrl,
      encoding: null,
      headers: populateHeaders(req.headers)
    }, function(err, rsp, body) {
      if (err) {
        console.warn("Failed while making upstream request:", err);
        return res.send(503);
      }

      if (rsp.statusCode === 200) {
        // copy the headers over
        Object.keys(rsp.headers).forEach(function(k) {
          res.set(k, rsp.headers[k]);
        });

        if (CACHE_EVERYTHING) {
          res.set("Cache-Control", "public,max-age=2592000");
        }

        // return it to the client
        res.send(body);

        // only write the file if it's cacheable
        if (isCacheable(rsp) && req.originalUrl !== '/') {
          metrics.mark("store");

          // pipe it into S3
          var s3Put = request.put({
            url: util.format("http://s3.amazonaws.com/%s%s", S3_BUCKET, req.originalUrl),
            body: body,
            aws: {
              key: AWS_ACCESS_KEY_ID,
              secret: AWS_SECRET_ACCESS_KEY
            },
            headers: populateS3Headers(rsp.headers)
          }, function(err, rsp, body) {
            if (err || rsp.statusCode !== 200) {
              console.warn("Failed while writing %s to S3:", req.originalUrl, err || rsp.statusCode);

              if (body) {
                console.warn(body);
              }

              return;
            }

            // console.log("%s successfully uploaded to %s.", req.originalUrl, S3_BUCKET);
          });
        }

        return;
      } else if (rsp.statusCode === 404) {
        return res.send(404);
      }

      console.log("Failed upstream request: %d: %s", rsp.statusCode, ORIGIN + req.originalUrl);

      // if we got here, neither request succeeded
      return res.send(503);
    });
});

// start the service
var server = app.listen(process.env.PORT || 8080, function() {
  console.log("Listening at http://%s:%d/", this.address().address, this.address().port);
});

// shutdown handler
process.on("SIGINT", function() {
  server.close();
  toobusy.shutdown();
  process.exit();
});
