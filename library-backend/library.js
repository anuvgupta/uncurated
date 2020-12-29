var fs = require('fs');
var ws = require('ws');
var path = require('path');
var axios = require('axios');
var sharp = require('sharp');
var fd = require('form-data');
var rn = require("random-number");
var mm = require('music-metadata');
var readline = require('readline');

var websocket, cli, app;

websocket = {
    url: null,
    socket: null,
    online: false,
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
    send: (event, data, silent = false) => {
        if (!silent) console.log('[ws] sending:', event, data);
        websocket.socket.send(websocket.encode_msg(event, data));
    },
    init: callback => {
        websocket.url = app.config.remote_ws;
        websocket.socket = new ws(websocket.url);
        websocket.socket.addEventListener('open', e => {
            console.log('[ws] socket connected');
            websocket.online = true;
            if (callback) callback();
        });
        websocket.socket.addEventListener('error', e => {
            console.log('[ws] socket error ', e.message);
        });
        websocket.socket.addEventListener('message', e => {
            var d = websocket.decode_msg(e.data);
            if (d != null) {
                console.log('[ws] socket received:', d.event, d.data);
                websocket.handle(d.event, d.data);
            } else {
                console.log('[ws] socket received:', 'invalid message', e.data);
            }
        });
        websocket.socket.addEventListener('close', e => {
            console.log('[ws] socket disconnected');
            websocket.online = false;
            websocket.reconnect();
        });
    },
    connect: _ => {
        websocket.init(_ => {
            websocket.api.login();
        });
    },
    reconnect: _ => {
        console.log(`[ws] reconnecting in ${app.config.ws_reconnect_interval / 1000} sec`);
        setTimeout(websocket.connect, app.config.ws_reconnect_interval);
    },
    handle: (event, data) => {
        switch (event) {
            case 'auth':
                if (data === true) {
                    console.log('[ws] authenticated');
                    websocket.api.identify();
                } else console.log('[ws] failed to authenticate');
                break;
            case 'get-song':
                if (data.path && data.path != '') {
                    app.uploadSong(data.id, data.path);
                }
                break;
            case 'get-art':
                if (data.path && data.path != '' && data.size) {
                    app.getArtwork(data.path, data.size, image => {
                        websocket.api.sendArtwork(data.id, image);
                    });
                }
                break;
            default:
                console.log(`[ws] unknown event ${event}`);
                break;
        }
    },
    api: {
        login: _ => {
            websocket.send('auth', {
                password: app.config.secret
            });
        },
        identify: _ => {
            websocket.send('identify', {
                type: 'library'
            });
        },
        sendArtwork: (id, image) => {
            websocket.send('artwork', {
                song_id: id,
                image: image
            }, true);
        }
    }
};

cli = {
    input: readline.createInterface({
        input: process.stdin,
        output: process.stdout
    }),
    init: _ => {
        cli.input.on('line', (line) => {
            line = line.trim();
            if (line != '') {
                line = line.split(' ');
                if (line[0] == "library") {
                    if (line.length > 1) {
                        if (line[1] == "update") {
                            var upload = (line.length > 2) && (line[2] == "upload");
                            console.log(`[app] updating metadata library`);
                            app.reindexMetadata(_ => {
                                if (upload) {
                                    console.log(`[app] uploading metadata library`);
                                    app.uploadLibrary();
                                }
                            });
                        } else if (line[1] == "upload") {
                            console.log(`[app] uploading metadata library`);
                            app.uploadLibrary();
                        }
                    }
                } else if (line[0] == "clear") {
                    console.clear();
                } else if (line[0] == "exit" || line[0] == "quit") {
                    console.log("[app] exit");
                    process.exit(0);
                }
            }
        });
    }
};

app = {
    ws: websocket,
    config: JSON.parse(fs.readFileSync('./config.json', { encoding: 'utf8', flag: 'r' })),
    isDir: dir => {
        return fs.existsSync(dir) && fs.lstatSync(dir).isDirectory();
    },
    randID: (exclude, length = 10) => {
        var key = "";
        var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        while (true) {
            for (var i = 0; i < length; i++)
                key += chars[rn({
                    min: 0,
                    max: chars.length - 1,
                    integer: true
                })];
            if (!exclude.includes(key)) break;
        }
        return key;
    },
    readAllSubFiles: (dir, files) => {
        var subfiles = fs.readdirSync(dir);
        for (var sf in subfiles) {
            var subfile_name = subfiles[sf];
            var subfile_path = path.join(dir, subfile_name);
            if (subfile_name == ".DS_Store") continue;
            else if (subfile_name.endsWith('.m4a') || subfile_name.endsWith('.mp3'))
                files.push(subfile_path);
            else if (app.isDir(subfile_path))
                app.readAllSubFiles(subfile_path, files);
        }
    },
    readMusicMetadata: (files, song_ids, handler, callback) => {
        if (files.length <= 0) callback();
        const file = files.shift();
        if (file) {
            var randomID = app.randID(song_ids);
            song_ids.push(randomID);
            mm.parseFile(file).then(md => {
                var metadata = {
                    id: randomID,
                    file: {
                        path: file,
                        container: md.format.container,
                        codec: md.format.codec,
                        duration: md.format.duration,
                        sample_rate: md.format.sampleRate,
                        bitrate: md.format.bitrate
                    },
                    song: {
                        track_num: md.common.track.no == null ? "" : md.common.track.no,
                        track_tot: md.common.track.of == null ? "" : md.common.track.of,
                        disk_num: md.common.disk.no == null ? "" : md.common.disk.no,
                        disk_tot: md.common.disk.of == null ? "" : md.common.disk.of,
                        title: md.common.hasOwnProperty('title') ? md.common.title : null,
                        artist: md.common.artist,
                        album: md.common.album,
                        album_artist: md.common.albumartist,
                        year: md.common.year,
                        copyright: md.common.copyright,
                        genre: md.common.hasOwnProperty('genre') ? md.common.genre.join(' ') : '',
                        advisory: ''
                    }
                };
                if (metadata.song.title == null)
                    metadata.song.title = path.basename(file, path.extname(file))
                if (md.hasOwnProperty('native') && md.native.hasOwnProperty('iTunes') && Array.isArray(md.native.iTunes)) {
                    for (var t in md.native.iTunes) {
                        var tag = md.native.iTunes[t];
                        if (tag.id == 'rtng' && (tag.value == 1 || tag.value == 4))
                            metadata.song.advisory = 'explicit';
                    }
                }
                handler(metadata);
                app.readMusicMetadata(files, song_ids, handler, callback);
            });
        }
    },
    getArtwork: (path, size, callback) => {
        mm.parseFile(path).then(md => {
            if (md.common.hasOwnProperty('picture') && md.common.picture[0]) {
                var picture = md.common.picture[0];
                sharp(picture.data).resize(size, size)
                    .toBuffer()
                    .then(data => {
                        picture.data = data.toString('base64');
                        if (callback) callback(picture);
                    })
                    .catch(err => {
                        console.err(err);
                    })
                    ;
            }
        });
    },
    expandArtistMetadata: library => {
        var separators = app.config.artist_parse.separators;
        var primary_separator = separators['__primary__'];
        delete separators['__primary__'];
        var exceptions = app.config.artist_parse.exceptions;
        var library_new = {
            time: 0,
            songs: {},
            artists: {}
        };
        for (var artist in library) {
            // convert artist metadata field to list of artists based on separators
            var artistFieldToList = artists => {
                // replace separator characters for artist name exceptions
                // ie. Tyler, the Creator --> Tyler\{symbol-comma-}/the Creator
                // allows the following splitting algorithm to work seamlessly
                for (var e in exceptions) {
                    if (artists.includes(exceptions[e])) {
                        var corrected_artist = exceptions[e];
                        for (var s in separators)
                            corrected_artist = corrected_artist.split(separators[s]).join(`\\{symbol-${s}-}/`);
                        artists = artists.split(exceptions[e]).join(corrected_artist);
                    }
                }
                // split artist names by separators
                for (var s in separators) {
                    if (s != primary_separator)
                        artists = artists.split(separators[s]).join(separators[primary_separator]);
                }
                artists = artists.split(separators[primary_separator]);
                // replace back separator characters for artist name exceptions
                for (var a in artists) {
                    artists[a] = artists[a].trim();
                    for (var s in separators)
                        artists[a] = artists[a].split(`\\{symbol-${s}-}/`).join(separators[s]);
                }
                return artists;
            };
            var artists = artistFieldToList(artist);
            // create artists in library and add song
            for (var album in library[artist]) {
                for (var s in library[artist][album]) {
                    if (!library_new.songs.hasOwnProperty(library[artist][album][s].id))
                        library_new.songs[library[artist][album][s].id] = library[artist][album][s];
                    var song_artists = artistFieldToList(library[artist][album][s].song.artist);
                    var all_artists = Array.from(new Set(artists.concat(song_artists)));
                    for (a in all_artists) {
                        if (!library_new.artists.hasOwnProperty(all_artists[a]))
                            library_new.artists[all_artists[a]] = {};
                        if (!library_new.artists[all_artists[a]].hasOwnProperty(album))
                            library_new.artists[all_artists[a]][album] = [];
                        library_new.artists[all_artists[a]][album].push(library[artist][album][s].id);
                    }
                }
            }
        }
        return library_new;
    },
    reindexMetadata: (callback = null) => {
        var timer = Date.now();
        console.log("[app] reindex metadata");
        var files = [];
        for (var s in app.config.sources)
            app.readAllSubFiles(app.config.sources[s], files);
        console.log(`${files.length} songs`);
        console.log(`eta ${(app.secondsPerSongEstimate * files.length).toFixed(1)} sec`);
        var song_ids = [];
        var metadata_library = {};
        app.readMusicMetadata(files, song_ids, metadata => {
            if (metadata) {
                var grouping_key = metadata.song.album_artist;
                if (grouping_key == null || grouping_key.trim() == '')
                    grouping_key = metadata.song.artist;
                if (grouping_key == '') grouping_key = '__null__';
                if (!metadata_library.hasOwnProperty(grouping_key))
                    metadata_library[grouping_key] = {};
                var grouping_subkey = metadata.song.album;
                if (grouping_subkey == null || grouping_subkey.trim() == '')
                    grouping_subkey = '__null__';
                if (!metadata_library[grouping_key].hasOwnProperty(grouping_subkey))
                    metadata_library[grouping_key][grouping_subkey] = [];
                metadata_library[grouping_key][grouping_subkey].push(metadata);
            }
            process.stdout.write('.');
        }, _ => {
            process.stdout.write('! \n');
            console.log('[app] save backups/library_raw.json');
            fs.writeFileSync('./backups/library_raw.json', JSON.stringify(metadata_library));
            console.log("[app] expanding artist metadata");
            metadata_library = app.expandArtistMetadata(metadata_library);
            metadata_library.time = Date.now();
            console.log('[app] save library.json');
            fs.writeFileSync('./library.json', JSON.stringify(metadata_library));
            timer = (Date.now() - timer) / 1000;
            console.log(`[app] done in ${timer.toFixed(1)} sec`);
            if (callback) callback();
        });
    },
    secondsPerSongEstimate: 0.01413106739, // 0.01016695753, 0.01108136421, 0.01413106739
    uploadLibrary: _ => {
        var form_data = new fd();
        form_data.append('library', fs.createReadStream('./library.json'));
        axios.post(`${app.config.remote_web}/upload-library`, form_data, {
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: form_data.getHeaders()
        }).then(result => {
            console.log("[app] uploaded library");
            if (result && result.data) console.log(result.data);
        }, error => {
            console.log("[app] failed to upload library");
            if (error) console.log(error);
        });
    },
    uploadSong: (id, path) => {
        try {
            if (fs.existsSync(path)) {
                var form_data = new fd();
                form_data.append('song', fs.createReadStream(path));
                axios.post(`${app.config.remote_web}/upload-song/${id}`, form_data, {
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    headers: form_data.getHeaders()
                }).then(result => {
                    console.log(`[app] uploaded song ${path}`);
                    if (result && result.data) console.log(result.data);
                }, error => {
                    console.log(`[app] failed to upload song ${path}`);
                    if (error) console.log(error);
                });
            }
        } catch (err) {
            console.error(err);
        }
    },
    run: _ => {
        // temp

        // var lib_temp = JSON.parse(fs.readFileSync('./backups/library_raw.json', { encoding: 'utf8', flag: 'r' }));
        // lib_temp = app.expandArtistMetadata(lib_temp);
        // fs.writeFileSync('./library.json', JSON.stringify(lib_temp));

        // app.reindexMetadata();

        // app.uploadLibrary();

        cli.init();
        websocket.connect();
    }
};

app.run();