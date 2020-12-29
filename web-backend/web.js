var fs = require('fs');
var ws = require('ws');
var http = require('http');
var path = require('path');
var bp = require('body-parser');
var express = require('express');
var mongodb = require('mongodb');
var rn = require('random-number');
var fu = require('express-fileupload');

var util, database, websocket, web, app;

util = {
    delay: (callback, timeout) => {
        setTimeout(_ => {
            process.nextTick(callback);
        }, timeout);
    },
    rand_id: (length = 10) => {
        var key = "";
        var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for (var i = 0; i < length; i++)
            key += chars[rn({
                min: 0,
                max: chars.length - 1,
                integer: true
            })];
        return key;
    }
};

database = {
    mdb: null,
    mdb_client: mongodb.MongoClient,
    o_id: mongodb.ObjectId,
    init: _ => {
        database.mdb_client.connect("mongodb://localhost:" + app.config.mdb_port, { useUnifiedTopology: true }, (err, client) => {
            if (err)
                console.log("[mdb] connection error", err);
            else {
                console.log(`[mdb] connected to ${app.config.mdb_port}`);
                database.mdb = client.db('uncurated');
                database.createSongSearchIndex(null);
            }
        });
    },
    updateLibrary: callback => {
        var metadata_library = JSON.parse(fs.readFileSync('./library.json', { encoding: 'utf8', flag: 'r' }));
        var song_list = Object.values(metadata_library.songs);
        var artist_list = [];
        for (var artist in metadata_library.artists) {
            var album_list = [];
            for (var album in metadata_library.artists[artist]) {
                album_list.push({
                    name: album,
                    songs: metadata_library.artists[artist][album]
                });
            }
            artist_list.push({
                name: artist,
                albums: album_list
            });
        }
        database.mdb.collection('songs').drop((err1, ok1) => {
            if (err1) console.log("[mdb] songs collection failed to delete", err1);
            else if (ok1) console.log("[mdb] songs collection deleted");
            database.mdb.collection('artists').drop((err2, ok2) => {
                if (err2) console.log("[mdb] artists collection failed to delete", err2);
                else if (ok2) console.log("[mdb] artists collection deleted");
                database.mdb.collection('songs').insertMany(song_list, (err3, res3) => {
                    if (err3) console.log("[mdb] songs failed to insert", err3);
                    else {
                        console.log(`[mdb] songs inserted: ${res3.insertedCount}`);
                        database.mdb.collection('artists').insertMany(artist_list, (err4, res4) => {
                            if (err4) console.log("[mdb] artists failed to insert", err4);
                            else {
                                console.log(`[mdb] artists inserted: ${res4.insertedCount}`);
                                database.createSongSearchIndex(callback);
                            }
                        });
                    }
                });
            });
        });
    },
    createSongSearchIndex: callback => {
        database.mdb.collection('songs').createIndex({
            "song.title": "text",
            "song.album": "text",
            "song.artist": "text"
        }, (err, res) => {
            if (err) console.log("[mdb] failed to create song search index");
            else console.log("[mdb] created song search index");
            if (callback) callback();
        });
    },
    rotateSong: song => {
        var timestamp = Date.now();
        var rotate_song = _ => {
            database.mdb.collection('rotation').insertOne({
                id: song.id,
                name: song.name,
                path: song.path,
                time: timestamp
            }, (err) => {
                if (err) console.log(`[mdb] failed to insert file rotation record for song ${song.id}`, err);
                else console.log(`[mdb] inserted file rotation record for song ${song.id}`);
            });
        };
        database.mdb.collection('rotation').find({}).toArray((err, list1) => {
            if (err) console.log(`[mdb] failed to find file rotation records`, err);
            else {
                database.mdb.collection('rotation').find({ id: song.id }).toArray((err, list2) => {
                    if (err) console.log(`[mdb] failed to find file rotation record for song ${song.id}`, err);
                    else {
                        if (list2.length == 0) {
                            if (list1.length >= app.config.file_rotate_limit) {
                                var min_timestamp = timestamp;
                                var min_ts_song_id = null;
                                for (var i in list1) {
                                    if (list1[i].time < min_timestamp) {
                                        min_timestamp = list1[i].time;
                                        min_ts_song_id = list1[i].id;
                                    }
                                }
                                if (min_ts_song_id) {
                                    database.mdb.collection('rotation').deleteOne({ id: min_ts_song_id, time: min_timestamp }, (err, obj) => {
                                        if (err) console.log(`[mdb] failed to delete file rotation record for song ${min_ts_song_id}`, err);
                                        else {
                                            console.log(`[mdb] deleted file rotation record for song ${min_ts_song_id}`);
                                            var del_file_path = `${__dirname}/library/audio/${min_ts_song_id}`;
                                            if (fs.existsSync(`${del_file_path}.mp3`)) del_file_path = `${del_file_path}.mp3`;
                                            else if (fs.existsSync(`${del_file_path}.m4a`)) del_file_path = `${del_file_path}.m4a`;
                                            else del_file_path = null;
                                            if (del_file_path !== null) {
                                                fs.unlink(del_file_path, (err) => {
                                                    if (err) console.log(`[mdb] failed to delete file ${del_file_path} for song ${min_ts_song_id}`);
                                                    else console.log(`[mdb] deleted file ${del_file_path} for song ${min_ts_song_id}`);
                                                    rotate_song();
                                                });
                                            } else rotate_song();
                                        }
                                    });
                                } else rotate_song();
                            } else rotate_song();
                        } else {
                            database.mdb.collection('rotation').updateOne({ id: song.id }, {
                                $set: { time: timestamp }
                            }, (err, result) => {
                                if (err) console.log(`[mdb] failed to update file rotation record for song ${song.id}`, err);
                                else console.log(`[mdb] updated file rotation record for song ${song.id}`);
                            });
                        }
                    }
                });
            }
        });
    }
};

websocket = {
    socket: null,
    online: false,
    clients: {}, // client sockets
    events: {}, // event handlers
    quiet_events: [],
    // encode event+data to JSON
    encode_msg: (e, d) => {
        return JSON.stringify({
            event: e,
            data: d
        });
    },
    // decode event+data from JSON
    decode_msg: (m) => {
        try {
            m = JSON.parse(m);
        } catch (e) {
            console.log("[ws] invalid json msg", e);
            m = null;
        }
        return m;
    },
    // send data to specific authenticated client
    send_to_client: (event, data, client) => {
        client.socket.send(websocket.encode_msg(event, data));
    },
    // send data to specific authenticated client
    trigger_for_client: (event, data, client) => {
        websocket.events[event](client, data, database.mdb);
    },
    // send data to specific type of client
    send_to_library_server: (event, data) => {
        for (var c in websocket.clients) {
            if (websocket.clients.hasOwnProperty(c) && websocket.clients[c].type == 'library') {
                websocket.send_to_client(event, data, websocket.clients[c]);
                break;
            }
        }
    },
    // bind handler to client event
    bind: (event, handler, auth_req = true) => {
        websocket.events[event] = (client, req, db) => {
            if (!auth_req || client.auth)
                handler(client, req, db);
        };
    },
    // initialize & attach events
    run: _ => {
        websocket.socket = new ws.Server({
            port: app.config.ws_port
        });
        // attach server socket events
        websocket.socket.on("connection", (client_socket) => {
            // create client object on new connection
            var client = {
                socket: client_socket,
                id: "_c_" + util.rand_id(),
                auth: false,
                type: "app"
            };
            console.log(`[ws] client ${client.id} – connected`);
            // client socket event handlers
            client.socket.addEventListener("message", (m) => {
                var d = websocket.decode_msg(m.data); // parse message
                if (d != null) {
                    // console.log('    ', d.event, d.data);
                    if (!websocket.quiet_events.includes(d.event))
                        console.log(`[ws] client ${client.id} – message: ${d.event}`, d.data);
                    else console.log(`[ws] client ${client.id} – message: ${d.event}`);
                    // handle various events
                    if (websocket.events.hasOwnProperty(d.event))
                        websocket.events[d.event](client, d.data, database.mdb);
                    else console.log("[ws] unknown event", d.event, d.data);
                } else console.log(`[ws] client ${client.id} – invalid message: `, m.data);
            });
            client.socket.addEventListener("error", (e) => {
                console.log("[ws] client " + client.id + " – error", e);
            });
            client.socket.addEventListener("close", (c, r) => {
                console.log(`[ws] client ${client.id} – disconnected`);
                delete websocket.clients[client.id]; // remove client object on disconnect
            });
            // add client object to client object list
            websocket.clients[client.id] = client;
        });
        websocket.socket.on("listening", _ => {
            console.log("[ws] listening on", app.config.ws_port);
            websocket.online = true;
        });
        websocket.socket.on("error", (e) => {
            console.log("[ws] server error", e);
            websocket.online = false;
        });
        websocket.socket.on("close", _ => {
            console.log("[ws] server closed");
            websocket.online = false;
        });

        /* bind events */

        // client: any
        websocket.bind('auth', (client, req, db) => {
            if (req.password != app.config.secret)
                websocket.send_to_client("auth", false, client);
            else {
                client.auth = true;
                websocket.send_to_client("auth", true, client);
                console.log(`[ws] client ${client.id} authenticated`);
            }
        }, false);

        // client: web panel
        websocket.bind('search-songs', (client, req, db) => {
            var search = (`${req.search}`).trim();
            if (search != '') {
                db.collection('songs')
                    .find({
                        $text: {
                            $search: search,
                            $caseSensitive: false,
                            $diacriticSensitive: true
                        }
                    })
                    .project({ score: { $meta: "textScore" } })
                    .sort({ score: { $meta: "textScore" } })
                    .toArray((err, list) => {
                        if (err) console.log(`[ws] client ${client.id} failed to search songs`, err);
                        else {
                            console.log(`[ws] client ${client.id} searching for ${search}`);
                            var result = [];
                            for (var i in list) {
                                result.push({
                                    id: list[i].id,
                                    title: list[i].song.title,
                                    artist: list[i].song.artist,
                                    album: list[i].song.album,
                                    duration: list[i].file.duration
                                });
                            }
                            websocket.send_to_client("search_songs", result, client);
                        }
                    });
            }
        });
        websocket.bind('play-song', (client, req, db) => {
            var song_id = (`${req.id}`).trim();
            if (song_id != '') {
                db.collection('songs').find({ id: song_id }).toArray((err, list) => {
                    if (err) console.log(`[ws] client ${client.id} failed to search songs`, err);
                    else {
                        if (list.length <= 0) {
                            console.log(`[ws] client ${client.id} no song with id ${song_id}`);
                        } else if (list.length > 1) {
                            console.log(`[ws] client ${client.id} multiple songs with id ${song_id}`);
                        } else {
                            console.log(`[ws] client ${client.id} playing song ${song_id}`);
                            app.queue_song(client, list[0].id, list[0]);
                            websocket.send_to_library_server('get-song', {
                                id: list[0].id,
                                path: list[0].file.path
                            });
                        }
                    }
                });
            }
        });
        websocket.bind('get-artwork-preview', (client, req, db) => {
            var song_ids = req.song_ids;
            if (song_ids.length > 0) {
                db.collection('songs').find({ id: { $in: song_ids } }).toArray((err, list) => {
                    if (err) console.log(`[ws] client ${client.id} failed to search songs`, err);
                    else {
                        if (list.length <= 0) {
                            console.log(`[ws] client ${client.id} no song with ids ${song_ids}`);
                        } else {
                            console.log(`[ws] client ${client.id} retrieving preview artwork for songs ${song_ids}`);
                            for (var i in list)
                                app.queue_art(client, list[i].id);
                            for (var i in list)
                                websocket.send_to_library_server('get-art', {
                                    id: list[i].id,
                                    path: list[i].file.path,
                                    size: app.config.artwork_small_size
                                });
                        }
                    }
                });
            }
        });
        websocket.bind('get-artwork-full', (client, req, db) => {
            var song_id = (`${req.id}`).trim();
            if (song_id != '') {
                db.collection('songs').find({ id: song_id }).toArray((err, list) => {
                    if (err) console.log(`[ws] client ${client.id} failed to search songs`, err);
                    else {

                        if (list.length <= 0) {
                            console.log(`[ws] client ${client.id} no song with id ${song_id}`);
                        } else if (list.length > 1) {
                            console.log(`[ws] client ${client.id} multiple songs with id ${song_id}`);
                        } else {
                            console.log(`[ws] client ${client.id} retrieving full artwork for songs ${song_id}`);
                            app.queue_art(client, list[0].id, true);
                            websocket.send_to_library_server('get-art', {
                                id: list[0].id,
                                path: list[0].file.path,
                                size: app.config.artwork_large_size
                            });
                        }
                    }
                });
            }
        });

        // client: library server
        websocket.bind('identify', (client, req, db) => {
            var identity = (`${req.type}`).trim();
            if (identity != '') {
                if (identity == 'library') {
                    client.type = 'library';
                    console.log(`[ws] client ${client.id} identified as library`);
                }
            }
        });
        websocket.bind('artwork', (client, req, db) => {
            if (req.song_id && req.image) {
                setTimeout(_ => {
                    app.send_art_queue(req.song_id, req.image);
                }, 50);
            }
        });
        websocket.quiet_events.push('artwork');
    }
};

web = {
    app: express(),
    server: null,
    run: _ => {
        web.server = http.Server(web.app);
        web.app.use(fu({ createParentPath: true }));
        web.app.use(bp.json());
        web.app.use(bp.urlencoded({ extended: true }));
        web.app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header(
                "Access-Control-Allow-Headers",
                "Origin, X-Requested-With, Content-Type, Accept"
            );
            next();
        });
        web.app.use(express.static("html"));
        web.app.get("/", (req, res) => {
            res.sendFile(__dirname + "/html/index.html");
        });
        web.app.get("/download-song/:song_id", (req, res) => {
            var song_id = `${req.params.song_id}`;
            var file_path = `${__dirname}/library/audio/${song_id}`;
            if (fs.existsSync(`${file_path}.mp3`)) file_path = `${file_path}.mp3`;
            else if (fs.existsSync(`${file_path}.m4a`)) file_path = `${file_path}.m4a`;
            else file_path = null;
            if (file_path !== null) {
                res.sendFile(file_path);
            } else res.status(404).send(`song "${song_id}" file not found`);
        });
        web.app.post('/upload-library', (req, res) => {
            try {
                if (!req.files) {
                    res.send({
                        status: false,
                        message: 'missing library file',
                        data: null
                    });
                } else {
                    let library = req.files.library;
                    library.mv(`./${library.name}`, _ => {
                        res.send({
                            status: true,
                            message: 'library file uploaded',
                            data: {
                                name: library.name,
                                mimetype: library.mimetype,
                                size: library.size
                            }
                        });
                        console.log('[web] library file received');
                        database.updateLibrary(_ => {
                            console.log('[web] library updated');
                        });
                    });
                }
            } catch (err) {
                console.log(err);
                res.status(500).send(err);
            }
        });
        web.app.post('/upload-song/:song_id', (req, res) => {
            try {
                if (!req.files) {
                    res.send({
                        status: false,
                        message: 'missing song file',
                        data: null
                    });
                } else {
                    let song_id = req.params.song_id;
                    let song = req.files.song;
                    let song_path = `./library/audio/${song_id}${path.extname(song.name)}`;
                    song.mv(song_path, _ => {
                        res.send({
                            status: true,
                            message: 'song file uploaded',
                            data: {
                                id: song_id,
                                name: song.name,
                                mimetype: song.mimetype,
                                size: song.size
                            }
                        });
                        console.log(`[web] song file ${song_id} received`);
                        setTimeout(_ => {
                            app.send_song_queue(song_id);
                        }, 50);
                        database.rotateSong({
                            id: song_id,
                            name: song.name,
                            path: song_path
                        });
                    });
                }
            } catch (err) {
                console.log(err);
                res.status(500).send(err);
            }
        });
        web.server.listen(app.config.http_port, _ => {
            console.log(`[http] listening on ${app.config.http_port}`);
        });
    }
};

app = {
    config: JSON.parse(fs.readFileSync('./config.json', { encoding: 'utf8', flag: 'r' })),
    song_queue: {},
    queue_song: (client, song_id, song_data) => {
        if (!app.song_queue.hasOwnProperty(song_id))
            app.song_queue[song_id] = {
                clients: []
            };
        app.song_queue[song_id].data = song_data;
        app.song_queue[song_id].clients.push(client);
    },
    send_song_queue: (song_id) => {
        if (app.song_queue.hasOwnProperty(song_id)) {
            var data = app.song_queue[song_id].data;
            var clients = app.song_queue[song_id].clients;
            delete app.song_queue[song_id];
            for (c in clients) {
                websocket.send_to_client('song_ready', {
                    id: song_id,
                    data: data
                }, clients[c]);
            }
        }
    },
    art_queue: {},
    queue_art: (client, song_id, large = false) => {
        if (!app.art_queue.hasOwnProperty(song_id))
            app.art_queue[song_id] = {
                large: large,
                clients: []
            };
        app.art_queue[song_id].clients.push(client);
    },
    send_art_queue: (song_id, artwork_data) => {
        if (app.art_queue.hasOwnProperty(song_id)) {
            var large = app.art_queue[song_id].large;
            var clients = app.art_queue[song_id].clients;
            delete app.art_queue[song_id];
            for (c in clients) {
                websocket.send_to_client('art_ready', {
                    id: song_id,
                    data: artwork_data,
                    large: large
                }, clients[c]);
            }
        }
    },
    run: _ => {
        database.init();
        websocket.run();
        web.run();
    }
};

app.run();