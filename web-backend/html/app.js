/* UNCURATED */
// web client

var app; app = {
    ui: {
        block: Block('div', 'app'),
        init: (callback) => {
            app.ui.block.fill(document.body);
            Block.queries();
            setTimeout(_ => {
                app.ui.block.css('opacity', '1');
            }, 100);
            setTimeout(_ => {
                Block.queries();
                setTimeout(_ => {
                    Block.queries();
                }, 200);
            }, 50);
            callback();
        },
    },
    ws: {
        id: 0,
        socket: null,
        url:
            (location.protocol === 'https:'
                ? 'wss://'
                : 'ws://') +
            document.domain +
            (document.domain == 'localhost' ? ':30000' : (location.protocol === 'https:' ? ':443' : ':80')) + '/socket',
        encode_msg: (e, d) => {
            return JSON.stringify({
                event: e,
                data: d
            });
        },
        decode_msg: (m) => {
            try {
                m = JSON.parse(m);
            } catch (e) {
                console.log('[ws] invalid json ', e);
                m = null;
            }
            return m;
        },
        connect: callback => {
            var socket = new WebSocket(app.ws.url);
            socket.addEventListener('open', e => {
                console.log('[ws] socket connected');
                callback();
            });
            socket.addEventListener('error', e => {
                console.log('[ws] socket error ', e.data);
            });
            socket.addEventListener('message', e => {
                var d = app.ws.decode_msg(e.data);
                if (d != null) {
                    console.log('[ws] socket received:', d.event, d.data);
                    var data = {};
                    data[d.event] = d.data;
                    app.ui.block.data(data);
                } else {
                    console.log('[ws] socket received:', 'invalid message', e.data);
                }
            });
            socket.addEventListener('close', e => {
                console.log('[ws] socket disconnected');
                // alert('disconnected from server');
            });
            window.addEventListener('beforeunload', e => {
                // socket.close(1001);
            });
            app.ws.socket = socket;
        },
        send: (event, data) => {
            console.log('[ws] sending:', event, data);
            app.ws.socket.send(app.ws.encode_msg(event, data));
        },
        api: {
            auth: null,
            login: (pass) => {
                app.ws.api.auth = { password: pass };
                app.ws.send('auth', app.ws.api.auth);
            },
            logout: _ => {
                util.delete_cookie('password');
                window.location.href = `${window.location.href}`;
            },
            search_songs: text => {
                app.ws.send('search-songs', {
                    search: text
                });
            },
            play_song: id => {
                app.ws.send('play-song', {
                    id: id
                });
            },
            get_artwork_preview: song_ids => {
                app.ws.send('get-artwork-preview', {
                    song_ids: song_ids
                });
            },
            get_artwork_full: song_id => {
                app.ws.send('get-artwork-full', {
                    id: song_id
                });
            }
        }
    },
    audio: {
        id: null,
        current: null,
        play_song: (id, path, on_end) => {
            console.log(`[audio] playing song ${id}`);
            app.audio.id = id;
            app.audio.current = new Howl({
                src: [path],
                autoplay: true,
                format: ['mp4', 'mp3']
            });
            app.audio.current.once('load', _ => {
                console.log(`[audio] loaded song ${id}`);
            });
            app.audio.current.on('end', _ => {
                console.log(`[audio] completed song ${id}`);
                on_end();
            });
        },
        resume_song: (fade = true) => {
            if (app.audio.current) {
                if (fade) {
                    app.audio.current.volume(0);
                    setTimeout(_ => {
                        app.audio.current.play();
                        app.audio.current.fade(0, 1, 250);
                    }, 10);
                } else app.audio.current.play();
            }
        },
        pause_song: (fade = true) => {
            if (app.audio.current) {
                if (fade) {
                    app.audio.current.fade(1, 0, 250);
                    setTimeout(_ => {
                        app.audio.current.pause();
                        app.audio.current.volume(1);
                    }, 250);
                } else app.audio.current.pause();
            }
        },
        stop_song: _ => {
            if (app.audio.current)
                app.audio.current.stop();
            app.audio.id = null;
            app.audio.current = null;
        },
        set_time: ratio => {
            if (app.audio.current)
                app.audio.current.seek(ratio * app.audio.current.duration());
        },
        get_dur: _ => {
            if (app.audio.current)
                return app.audio.current.duration();
            return -1;
        },
        timer_latch: null,
        timer_key: null,
        timer_interval: 5,
        start_timer: _ => {
            app.audio.timer_key = setInterval(_ => {
                if (app.audio.timer_latch && app.audio.current)
                    app.audio.timer_latch(app.audio.current.seek(), app.audio.current.state(), app.audio.current.playing());
            }, app.audio.timer_interval);
        },
        latch_timer: handler => {
            app.audio.timer_latch = handler;
        }
    },
    main: {
        init: _ => {
            console.clear();
            console.log('[main] loading...');
            setTimeout(_ => {
                app.ui.block.load(_ => {
                    app.ui.block.load(_ => {
                        console.log('[main] blocks loaded');
                        console.log('[main] socket connecting');
                        app.ws.connect(_ => {
                            app.ui.init(_ => {
                                console.log('[main] ready');
                                app.audio.start_timer();
                                if (util.cookie('password') != null) {
                                    app.ws.api._temp_prelogin = true;
                                    app.ws.api.login(util.cookie('password'));
                                }
                            });
                        });
                    }, 'app', 'jQuery');
                }, 'blocks', 'jQuery');
            }, 300);
        }
    }
};

$(document).ready(app.main.init);