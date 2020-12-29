/* UNCURATED */
// utilities

var util; util = {
    mobile: _ => {
        return jQuery.browser.mobile;
    },
    cookie: (id, val, date) => {
        if (Block.is.unset(val))
            document.cookie.split('; ').forEach(cookie => {
                if (cookie.substring(0, id.length) == id)
                    val = cookie.substring(id.length + 1);
            });
        else {
            if (date == '__indefinite__')
                date = 'Fri, 31 Dec 9999 23:59:59 GMT';
            document.cookie =
                id +
                '=' +
                val +
                (Block.is.set(date) ? '; expires=' + date : '');
        }
        return Block.is.unset(val) ? null : val;
    },
    delete_cookie: id => {
        util.cookie(id, '', 'Thu, 01 Jan 1970 00:00:00 GMT');
    },
    sha256: (str, callback) => {
        if (callback) callback(window.sha256(str));
    },
    sha256_secure: (str, callback) => {
        const msgUint8 = new TextEncoder("utf-8").encode(str);
        const hashBuffer_promise = crypto.subtle.digest('SHA-256', msgUint8);
        hashBuffer_promise.then(hashBuffer => {
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            if (callback) callback(hashHex);
        });
    }, // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
    lpad: (s, width, char) => {
        return s.length >= width
            ? s
            : (new Array(width).join(char) + s).slice(-width);
    }, // https://stackoverflow.com/questions/10841773/javascript-format-number-to-day-with-always-3-digits
    capitalize: word => {
        return word.charAt(0).toUpperCase() + word.slice(1);
    },
    duration_desc: seconds => {
        var minutes = Math.floor(seconds / 60);
        var seconds = Math.floor(seconds - (minutes * 60));
        return {
            minutes: `${minutes}`,
            seconds: `${util.lpad(`${seconds}`, 2, '0')}`
        };
    },
    requery: _ => {
        Block.queries();
        setTimeout(_ => {
            Block.queries();
        }, 50);
    },
    paginate: (list, items_per_page) => {
        var result = [];
        var sublist = [];
        var count = 0;
        for (var l in list) {
            count++;
            sublist.push(list[l]);
            if (count == items_per_page) {
                count = 0;
                result.push(sublist);
                sublist = [];
            }
        }
        if (count > 0) result.push(sublist);
        return result;
    },
    download_file: (path, block, callback) => {
        var dl_frame_mark = `temp_download_iframe_${Date.now()}`;
        var dl_frame = Block('iframe', dl_frame_mark)
            .css({
                display: 'none',
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%'
            })
            .on('load', (event, block, data) => {
                if (callback) callback();
            });
        block.add(dl_frame);
        dl_frame.data({
            src: path
        });
    }
};