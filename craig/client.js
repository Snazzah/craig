/*
 * Copyright (c) 2017, 2018 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/*
 * Craig: A multi-track voice channel recording bot for Discord.
 *
 * The actual Discord client, some logging and other core functionality.
 */

const EventEmitter = require("events");
const fs = require("fs");
const Discord = require("discord.js");
const Eris = require("eris");
const ShardedRequestHandler = require("./requesthandler.js");
require("./eris-flavor.js");

const cdb = require("./db.js");
const log = cdb.log;

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const defaultConfig = require("./default-config.js");

for (var ck in defaultConfig)
    if (!(ck in config))
        config[ck] = defaultConfig[ck];

// List of commands coming from shards
const shardCommands = {};

// List of commands coming from the shard manager or launcher
const processCommands = {};

// Are we a shard?
const shard = ("SHARD_ID" in process.env);

// Create a client with either Eris or Discord.js
function mkClient(token) {
    var ret;
    if (shard) {
        var shardId = +process.env["SHARD_ID"];

        ret = new Eris.Client(token, {
            firstShardID: +process.env["SHARD_ID"],
            lastShardID: +process.env["SHARD_ID"],
            maxShards: +process.env["SHARD_COUNT"],
            ratelimiterOffset: 500
        });
    } else {
        ret = new Eris.Client(token);
    }
    ret.requestHandler = new ShardedRequestHandler(
        ret, ret.requestHandler.options,
        shard && config.localAddress ? config.localAddress[shardId % config.localAddress.length] : null
    );

    if ("url" in config) ret.on("ready", () => {
        // Do this frequently to make sure we stay online
        setInterval(() => {
            ret.editStatus("online", {name: config.url, type: 0});
        }, 3600000);
    });

    return ret;
}

var vclient, vsm, vmaster;

if (!config.shard || shard) {
    // Either we aren't using sharding, or we are a shard, so normal client connection
    vclient = mkClient(config.token);
    vsm = null;
    vmaster = !shard;
} else {
    // We are the sharding manager
    vclient = null;
    vsm = new Discord.ShardingManager("./craig.js", {token: config.token, totalShards: 128});
    vmaster = true;
}

const client = vclient;
const sm = vsm;
const master = vmaster;
const clients = [client]; // For secondary connections

// A message to distinguish us from other shards
var vshardMsg = "";
if (shard)
    vshardMsg = " (shard " + (+process.env["SHARD_ID"]) + "/" + (+process.env["SHARD_COUNT"]) + ", pid " + process.pid + ")";
const shardMsg = vshardMsg;

if (!sm) {
    // If there are secondary Craigs, spawn them
    for (var si = 0; si < config.secondary.length; si++) {
        clients.push(mkClient(config.secondary[si].token));
    }
}

// Announce our connection
if (client) client.on("ready", () => {
    log("login", "Logged in as " + client.user.username + shardMsg);
});

// Announce problems
if (client) {
    for (var si = 0; si < clients.length; si++) (function(si) {
        var client = clients[si];

        client.on("disconnect", (err) => {
            log("disconnected", "(" + si + ") " + err + shardMsg);
        });

        client.on("shardDisconnect", (err) => {
            log("shard-disconnected", "(" + si + ") " + err + shardMsg);
        });

        client.on("error", (err) => {
            log("client-error", "(" + si + ") " + shardMsg + " " + err + " " + JSON.stringify(err.stack+""));
        });
    })(si);
}

// Handle shard commands
if (sm) sm.on("message", (shard, msg) => {
    if (typeof msg !== "object") return;
    var fun = shardCommands[msg.t];
    if (fun) fun(shard, msg);
});

// And process commands
process.on("message", (msg) => {
    if (typeof msg !== "object") return;
    if (("from" in msg) && client && client.shard && client.shard.id === msg.from)
        return; // Ignore messages rebroadcast to ourselves
    var fun = processCommands[msg.t];
    if (fun) fun(msg);
});

// An event emitter for whenever we start or stop any recording
class RecordingEvent extends EventEmitter {}
const recordingEvents = new RecordingEvent();

// Log exceptions
function logex(ex, r) {
    if (typeof r === "undefined") r = "";
    log("exception", r + " " + JSON.stringify(ex.stack+""));
}

// Convenience function to turn entities into name#id strings:
function nameId(entity) {
    var nick = "";
    if ("displayName" in entity) {
        nick = entity.displayName;
    } else if ("username" in entity) {
        nick = entity.username;
    } else if ("name" in entity) {
        nick = entity.name;
    }
    return nick + "#" + entity.id;
}

if (client) {
    // Log in
    client.login(config.token).catch(logex);
} else {
    // Spawn shards
    sm.spawn();
}

if (!sm) {
    // If there are secondary Craigs, log them in
    for (var si = 0; si < config.secondary.length; si++) {
        clients[si+1].login(config.secondary[si].token);
    }
}

module.exports = {
    client, sm, master, clients,
    config,
    recordingEvents,
    logex,
    shardCommands, processCommands,
    nameId,
    dead: false
};
