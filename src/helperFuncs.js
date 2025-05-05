module.exports = {
    getCurrentProgramAndTimeElapsed: getCurrentProgramAndTimeElapsed,
    createLineup: createLineup,
    getWatermark: getWatermark,
    generateChannelContext: generateChannelContext,
}

let channelCache = require('./channel-cache');
const INFINITE_TIME = new Date().getTime() + 10*365*24*60*60*1000; //10 years from the initialization of the server. I dunno, I just wanted it to be a high time without it stopping being human readable if converted to date.
const SLACK = require('./constants').SLACK;
const randomJS = require("random-js");
const quickselect = require("quickselect");
const Random = randomJS.Random;
const random = new Random( randomJS.MersenneTwister19937.autoSeed() );

const CHANNEL_CONTEXT_KEYS = [
    "disableFillerOverlay",
    "watermark",
    "icon",
    "offlinePicture",
    "offlineSoundtrack",
    "name",
    "transcoding",
    "number",
];

module.exports.random = random;

function getCurrentProgramAndTimeElapsed(date, channel) {
    // If seekPosition is not set, default to 0
    function getSeek(program) {
        return typeof program.seekPosition === 'number' ? program.seekPosition : 0;
    }
    function getEnd(program) {
        return typeof program.endPosition === 'number' ? program.endPosition : null;
    }
    let channelStartTime = (new Date(channel.startTime)).getTime();
    if (channelStartTime > date) {
        let t0 = date;
        let t1 = channelStartTime;
        console.log("Channel start time is above the given date. Flex time is picked till that.");
        return {
            program: {
                isOffline: true,
                duration : t1 - t0,
            },
            timeElapsed: 0,
            programIndex: -1,
        }
    }
    let timeElapsed = (date - channelStartTime) % channel.duration
    let currentProgramIndex = -1
    for (let y = 0, l2 = channel.programs.length; y < l2; y++) {
        let program = channel.programs[y];
        // Compute effective duration based on seek/end
        let seek = getSeek(program);
        let end = getEnd(program);
        let effectiveDurationForProgram = (end !== null ? end : program.duration) - seek;
        if (timeElapsed - effectiveDurationForProgram < 0) {
            currentProgramIndex = y
            if ( ((end !== null ? end - seek : program.duration - seek) > 2*SLACK) && (timeElapsed > (end !== null ? end - seek : program.duration - seek) - SLACK) ) {
                timeElapsed = 0;
                currentProgramIndex = (y + 1) % channel.programs.length;
            }
            break;
        } else {
            timeElapsed -= (end !== null ? end - seek : program.duration - seek);
        }
    }

    if (currentProgramIndex === -1)
        throw new Error("No program found; find algorithm fucked up")

    // Attach seek/end for downstream use
    let program = channel.programs[currentProgramIndex];
    let seek = getSeek(program);
    let end = getEnd(program);
    let effectiveDurationForProgram = (end !== null ? end : program.duration) - seek;
    return {
        program: Object.assign({}, program, { seekPosition: seek, endPosition: end, effectiveDuration: effectiveDurationForProgram }),
        timeElapsed: timeElapsed,
        programIndex: currentProgramIndex
    }
}

function createLineup(programPlayTime, obj, channel, fillers, isFirst) {
    let timeElapsed = obj.timeElapsed
    // Start time of a file is never consistent unless 0. Run time of an episode can vary. 
    // When within 30 seconds of start time, just make the time 0 to smooth things out
    // Helps prevents loosing first few seconds of an episode upon lineup change
    let activeProgram = obj.program
    let beginningOffset = 0;
    // Use seekPosition and endPosition for effective start and duration
    let seek = typeof activeProgram.seekPosition === 'number' ? activeProgram.seekPosition : 0;
    let end = typeof activeProgram.endPosition === 'number' ? activeProgram.endPosition : null;

    let lineup = []

    if ( typeof(activeProgram.err) !== 'undefined') {
        let remaining = activeProgram.duration - timeElapsed;
        lineup.push( {
            type: 'offline',
            title: 'Error',
            err: activeProgram.err,
            streamDuration: remaining,
            duration: remaining,
            start: 0,
            beginningOffset: beginningOffset,
        })
        return lineup;
    }


    if (activeProgram.isOffline === true) {
        //offline case
        let remaining = activeProgram.duration - timeElapsed;
        //look for a random filler to play
        let filler = null;
        let special = null;

            if ( (channel.offlineMode === 'clip') && (channel.fallback.length != 0) ) {
                special = JSON.parse(JSON.stringify(channel.fallback[0]));
            }
            let randomResult = pickRandomWithMaxDuration(programPlayTime, channel, fillers, remaining + (isFirst? (7*24*60*60*1000) : 0) );
            filler = randomResult.filler;
            if (filler == null && (typeof(randomResult.minimumWait) !== undefined) && (remaining > randomResult.minimumWait) ) {
                remaining = randomResult.minimumWait;
            }

        let isSpecial = false;
        if (filler == null) {
            filler = special;
            isSpecial = true;
        }
        if (filler != null) {
            let fillerstart = 0;
            if (isSpecial) {
                if (filler.duration > remaining) {
                    fillerstart = filler.duration - remaining;
                } else {
                    ffillerstart = 0;
                }
            } else if(isFirst) {
                fillerstart = Math.max(0, filler.duration - remaining);
                //it's boring and odd to tune into a channel and it's always
                //the start of a commercial.
                let more = Math.max(0, filler.duration - fillerstart - 15000 - SLACK);
                fillerstart +=  random.integer(0, more);
            }
            lineup.push({   // just add the video, starting at 0, playing the entire duration
                type: 'commercial',
                title: filler.title,
                key: filler.key,
                plexFile: filler.plexFile,
                file: filler.file,
                ratingKey: filler.ratingKey,
                start: fillerstart,
                streamDuration: Math.max(1, Math.min(filler.duration - fillerstart, remaining) ),
                duration: filler.duration,
                fillerId: filler.fillerId,
                beginningOffset: beginningOffset,
                serverKey: filler.serverKey
            });
            return lineup;
        }
        // pick the offline screen
        remaining = Math.min(remaining, 10*60*1000);
        //don't display the offline screen for longer than 10 minutes. Maybe the
        //channel's admin might change the schedule during that time and then
        //it would be better to start playing the content.
        lineup.push( {
            type: 'offline',
            title: 'Channel Offline',
            streamDuration: remaining,
            beginningOffset: beginningOffset,
            duration: remaining,
            start: 0
        })
        return lineup;
    }
    let originalTimeElapsed = timeElapsed;
    if (timeElapsed < 30000) {
        timeElapsed = 0
    }
    beginningOffset = Math.max(0, originalTimeElapsed - timeElapsed);

    // Calculate effective start, duration, and streamDuration using seek/end
    const effectiveSeek = seek;
    const effectiveEnd = end !== null ? end : activeProgram.duration;
    const effectiveDuration = effectiveEnd - effectiveSeek;
    const effectiveTimeElapsed = Math.max(0, timeElapsed);
    const effectiveStreamDuration = effectiveDuration - effectiveTimeElapsed;

    return [{
        type: 'program',
        title: activeProgram.title,
        key: activeProgram.key,
        plexFile: activeProgram.plexFile,
        file: activeProgram.file,
        ratingKey: activeProgram.ratingKey,
        start: effectiveSeek + effectiveTimeElapsed, // playback should start at seek + elapsed
        streamDuration: effectiveStreamDuration,
        beginningOffset: beginningOffset,
        duration: effectiveDuration,
        originalDuration: activeProgram.duration,
        serverKey: activeProgram.serverKey,
        seekPosition: effectiveSeek,
        endPosition: end
    }];
}

function weighedPick(a, total) {
    return random.bool(a, total);
}

function pickRandomWithMaxDuration(programPlayTime, channel, fillers, maxDuration) {
    let list = [];
    for (let i = 0; i < fillers.length; i++) {
        list = list.concat(fillers[i].content);
    }
    let pick1 = null;

    let t0 = (new Date()).getTime();
    let minimumWait = 1000000000;
    const D = 7*24*60*60*1000;
    const E = 5*60*60*1000;
    if (typeof(channel.fillerRepeatCooldown) === 'undefined') {
        channel.fillerRepeatCooldown = 30*60*1000;
    }
    let listM = 0;
    let fillerId = undefined;

    for (let medianCheck = 1; medianCheck >= 0; medianCheck--) {
     for (let j = 0; j < fillers.length; j++) {
      list = fillers[j].content;
      let pickedList = false;
      let n = 0;

      let maximumPlayTimeAllowed = INFINITE_TIME;
      if (medianCheck==1) {
          //calculate the median
          let median = getFillerMedian(programPlayTime, channel, fillers[j]);
          if (median > 0) {
              maximumPlayTimeAllowed = median - 1;
              // allow any clip with a play time that's less than the median.
          } else {
              // initially all times are 0, so if the median is 0, all of those
              // are allowed.
              maximumPlayTimeAllowed = 0;
          }
      }


      for (let i = 0; i < list.length; i++) {
        let clip = list[i];
        // a few extra milliseconds won't hurt anyone, would it? dun dun dun
        if (clip.duration <= maxDuration + SLACK ) {
            let t1 = channelCache.getProgramLastPlayTime(programPlayTime, channel.number, clip );
            if (t1 > maximumPlayTimeAllowed) {
                continue;
            }
            let timeSince = ( (t1 == 0) ?  D :  (t0 - t1) );

            if (timeSince < channel.fillerRepeatCooldown - SLACK) {
                let w = channel.fillerRepeatCooldown - timeSince;
                if (clip.duration + w <= maxDuration + SLACK) {
                    minimumWait = Math.min(minimumWait, w);
                }
                timeSince = 0;
                //30 minutes is too little, don't repeat it at all
            } else if (!pickedList) {
                let t1 = channelCache.getFillerLastPlayTime( channel.number, fillers[j].id );
                let timeSince = ( (t1 == 0) ?  D :  (t0 - t1) );
                if (timeSince + SLACK >= fillers[j].cooldown) {
                    //should we pick this list?
                    listM += fillers[j].weight;
                    if ( weighedPick(fillers[j].weight, listM) ) {
                        pickedList = true;
                        fillerId = fillers[j].id;
                        n = 0;
                    } else {
                        break;
                    }
                } else {
                    let w = fillers[j].cooldown - timeSince;
                    if (clip.duration + w <= maxDuration + SLACK) {
                        minimumWait = Math.min(minimumWait, w);
                    }
    
                    break;
                }
            }
            if (timeSince <= 0) {
                continue;
            }
            let s = norm_s( (timeSince >= E) ?  E : timeSince );
            let d = norm_d( clip.duration);
            let w = s + d;
            n += w;
            if (weighedPick(w,n)) {
                pick1 = clip;
            }
        }
      }
     }
     if (pick1 != null) {
        break;
     }
    }
    let pick = pick1;
    if (pick != null) {
        pick = JSON.parse( JSON.stringify(pick) );
        pick.fillerId = fillerId;
    }
    
   
    return {
        filler: pick,
        minimumWait : minimumWait,
    }
}

function norm_d(x) {
    x /= 60 * 1000;
    if (x >= 3.0) {
        x = 3.0 + Math.log(x);
    }
    let y = 10000 * ( Math.ceil(x * 1000) + 1 );
    return Math.ceil(y / 1000000) + 1;
}

function norm_s(x) {
    let y = Math.ceil(x / 600) + 1;
    y = y*y;
    return Math.ceil(y / 1000000) + 1;
}


// any channel thing used here should be added to channel context
function getWatermark(  ffmpegSettings, channel, type) {
    if (! ffmpegSettings.enableFFMPEGTranscoding || ffmpegSettings.disableChannelOverlay ) {
        return null;
    }
    let d = channel.disableFillerOverlay;
    if (typeof(d) === 'undefined') {
        d = true;
    }
    if ( (typeof type !== `undefined`) && (type == 'commercial') && d ) {
        return null;
    }
    let e = false;
    let icon = undefined;
    let watermark = {};
    if (typeof(channel.watermark) !== 'undefined') {
        watermark = channel.watermark;
        e = (watermark.enabled === true);
        icon = watermark.url;
    }
    if (! e) {
        return null;
    }
    if ( (typeof(icon) === 'undefined') || (icon === '') ) {
        icon = channel.icon;
        if ( (typeof(icon) === 'undefined') || (icon === '') ) {
            return null;
        }
    }
    let result = {
        url: icon,
        width: watermark.width,
        verticalMargin: watermark.verticalMargin,
        horizontalMargin: watermark.horizontalMargin,
        duration: watermark.duration,
        position: watermark.position,
        fixedSize: (watermark.fixedSize === true),
        animated: (watermark.animated === true),
    }
    return result;
}


function getFillerMedian(programPlayTime, channel, filler) {

    let times = [];
    list = filler.content;
    for (let i = 0; i < list.length; i++) {
        let clip = list[i];
        let t = channelCache.getProgramLastPlayTime(programPlayTime, channel.number, clip);
        times.push(t);
    }

    if (times.length <= 1) {
        //if there are too few elements, the protection is not helpful.
        return INFINITE_TIME;
    }
    let m = Math.floor(times.length / 2);
    quickselect(times, m)
    return times[m];

}

function generateChannelContext(channel) {
    let channelContext = {};
    for (let i = 0; i < CHANNEL_CONTEXT_KEYS.length; i++) {
        let key = CHANNEL_CONTEXT_KEYS[i];

        if (typeof(channel[key]) !== 'undefined') {
            channelContext[key] = JSON.parse( JSON.stringify(channel[key] ) );
        }
    }
    return channelContext;
}
