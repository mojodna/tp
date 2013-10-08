"use strict";

var assert = require("assert");

var async = require("async"),
    express = require("express");

process.env.DISABLE_METRICS = true;

var ORIGIN = "http://localhost:8080";

var siphon = require("../lib")({
  ORIGIN: ORIGIN,
  AWS_ACCESS_KEY_ID: "x",
  AWS_SECRET_ACCESS_KEY: "x",
  S3_BUCKET: "test",
  S3_URL: "http://localhost:8081",
  CACHE_EVERYTHING: true
});

var checks = [];

var check = function(check) {
  checks.push(check);
};

var expected = function(done) {
  var self = expected;

  return function(callback) {
    self.count = self.count || 0;
    self.count++;

    return function() {
      self.count--;

      callback.apply(this, arguments);

      if (self.count === 0) {
        // evaluate each of the captured checks
        try {
          checks.forEach(function(check) {
            check.call(null);
          });
        } catch (e) {
          // since we have a different stack, pass the exception forward
          return done(e);
        } finally {
          checks = [];
        }

        return done();
      }
    };
  };
};

describe("#fetchAndStore", function() {
  var origin,
      originServer,
      s3,
      s3Server;

  beforeEach(function(ready) {
    async.parallel([
      function(done) {
        origin = express();
        originServer = origin.listen(8080, done);
      },
      function(done) {
        s3 = express();
        s3Server = s3.listen(8081, done);
      }
    ], ready);
  });

  afterEach(function(complete) {
    async.parallel([
      function(done) {
        originServer.close(done);
      },
      function(done) {
        s3Server.close(done);
      }
    ], complete);
  });

  it("makes an upstream request", function(done) {
    var contentType = "text/plain",
        payload = "ok",
        referrer = "http://www.google.com/",
        userAgent = "siphon";

    var expects = expected(done);

    origin.get("/resource", expects(function(req, res) {
      check(function() {
        // verify that "important" request headers are passed through
        assert.equal(referrer, req.headers.referer);
        assert.equal(userAgent, req.headers["user-agent"]);
      });

      res.set("Content-Type", contentType);
      return res.send(payload);
    }));

    s3.put("/test/resource", expects(function(req, res) {
      var chunks = [];

      req
        .on("data", function(chunk) {
          chunks.push(chunk);
        })
        .on("end", function() {
          var body = Buffer.concat(chunks).toString();

          check(function() {
            // did the payload get passed through?
            assert.equal(payload, body);

            // S3-required headers
            assert.ok(req.headers.authorization);
            assert.equal("public-read", req.headers["x-amz-acl"]);

            // default cache-control headers (when CACHE_EVERYTHING is true)
            assert.equal("public,max-age=300", req.headers["cache-control"]);

            assert.ok(req.headers["content-type"].indexOf(contentType) >= 0);
          });

          return res.send(200);
        });
    }));

    var headers = {
      referer: referrer,
      "user-agent": userAgent
    };

    siphon.fetchAndStore(ORIGIN + "/resource", "/resource", headers, expects(function(err, rsp, body) {
      assert.equal(payload, body);
      assert.ok(rsp.headers["content-type"].indexOf(contentType) >= 0);
    }));
  });

  it("respects Cache-Control headers", function(done) {
    var cacheControl = "public,max-age=3600";

    var expects = expected(done);

    origin.get("/resource", expects(function(req, res) {
      res.set("Cache-Control", cacheControl);
      return res.send("ok");
    }));

    s3.put("/test/resource", expects(function(req, res) {
      check(function() {
        assert.equal("public,max-age=3600", req.headers["cache-control"]);
      });

      return res.send(200);
    }));

    siphon.fetchAndStore(ORIGIN + "/resource", "/resource", {}, expects(function(err, rsp, body) {
      assert.equal(cacheControl, rsp.headers["cache-control"]);
    }));
  });

  it("handles 500s properly", function(done) {
    var statusCode = 500;

    var expects = expected(done);

    origin.get("/resource", expects(function(req, res) {
      return res.send(statusCode);
    }));

    s3.put("/test/resource", function(req, res) {
      check(function() {
        assert.fail();
      });

      res.send(500);
    });

    siphon.fetchAndStore(ORIGIN + "/resource", "/resource", {}, expects(function(err, rsp, body) {
      assert.equal(statusCode, rsp.statusCode);
    }));
  });

  it("doesn't cache uncacheable content", function(done) {
    var siphon = require("../lib")({
      ORIGIN: "http://localhost:8080",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      S3_BUCKET: "test",
      S3_URL: "http://localhost:8081"
    });

    var payload = "ok";

    var expects = expected(done);

    origin.get("/resource", expects(function(req, res) {
      res.set("Cache-Control", "max-age=0");
      return res.send(payload);
    }));

    s3.put("/test/resource", function(req, res) {
      check(function() {
        assert.fail();
      });

      res.send(500);
    });

    siphon.fetchAndStore(ORIGIN + "/resource", "/resource", {}, expects(function(err, rsp, body) {
      assert.equal(payload, body);
    }));
  });
});
