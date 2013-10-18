#!/usr/bin/env node
"use strict";

var http = require("http"),
    path = require("path"),
    url = require("url"),
    util = require("util");

var env = require("require-env"),
    express = require("express"),
    request = require("request"),
    toobusy = require("toobusy"),
    metricsd = require("metricsd");

var app = express(),
    metrics = metricsd({
      log: !!process.env.ENABLE_METRICS
    });

//
// Configuration
//

var ORIGIN = env.require("ORIGIN");

var tp = require("../lib")({
  ORIGIN: ORIGIN,
  AWS_ACCESS_KEY_ID: env.require("AWS_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: env.require("AWS_SECRET_ACCESS_KEY"),
  S3_BUCKET: env.require("S3_BUCKET"),
  S3_URL: process.env.S3_URL,
  CACHE_EVERYTHING: process.env.CACHE_EVERYTHING
});

http.globalAgent.maxSockets = Infinity;

var config = {};

if (process.env.TP_CONFIG) {
  // TODO this is a really dumb way to load the config
  // a command-line option would be better
  try {
    config = require(process.env.TP_CONFIG);
  } catch (e) {
    try {
      config = require(path.join(process.cwd(), process.env.TP_CONFIG));
    } catch (e) {
    }
  }
}

var proxy = function(origin) {
  return function(req, res) {
    if (toobusy()) {
      // TODO extract the throttling code from sandwich-maker
      metrics.mark("busy");
    }

    var path = req.url;

    if (path === "/" ||
        url.parse(path).query) {

      metrics.mark("pass");
      return req.pipe(request(origin + path)).pipe(res);
    }

    return tp.fetchAndStore(origin + path, req.originalUrl, req.headers, function(err, rsp, body) {
      if (err) {
        metrics.mark("error");
        return res.send(503);
      }

      if (rsp.statusCode === 200) {
        // copy the headers over
        Object.keys(rsp.headers).forEach(function(k) {
          res.set(k, rsp.headers[k]);
        });

        // return it to the client
        return res.send(body);
      } else if (rsp.statusCode === 404) {
        return res.send(404);
      }

      // if we got here, neither request succeeded
      metrics.mark("error");
      return res.send(503);
    });
  };
};

Object.keys(config).forEach(function(path) {
  var origin = config[path];

  console.log("Registering proxy for %s", path);
  app.use(path, proxy(config[path]));
});


//
// Express configuration
//

app.disable("x-powered-by");
app.use(express.responseTime());

app.configure("development", function() {
  app.use(express.logger());
});


//
// Timers
//

setInterval(function() {
  metrics.updateHistogram("lag", toobusy.lag());
}, 1000).unref();


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

  var path = req.originalUrl;

  if (path === "/" ||
      url.parse(path).query) {

    metrics.mark("pass");
    return req.pipe(request(ORIGIN + path)).pipe(res);
  }

  return tp.fetchAndStore(ORIGIN + path, path, req.headers, function(err, rsp, body) {
    if (err) {
      metrics.mark("error");
      return res.send(503);
    }

    if (rsp.statusCode === 200) {
      // copy the headers over
      Object.keys(rsp.headers).forEach(function(k) {
        res.set(k, rsp.headers[k]);
      });

      // return it to the client
      return res.send(body);
    } else if (rsp.statusCode === 404) {
      return res.send(404);
    }

    // if we got here, neither request succeeded
    metrics.mark("error");
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
