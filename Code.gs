// Copyright 2015 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Author: Corey Goldfeder
// Contributor: Schuyler Duveen

function getConfig() {
  var userProperties = PropertiesService.getUserProperties();
  var cfg = userProperties.getProperty('config');
  Logger.log(cfg);
  if (cfg) {
    return JSON.parse(cfg);
  } else {
    return { numDays: 7,
             markUnread: false,
             addUnsnoozed: false,
             calendarNotificationsToGuests: false,
             debugTime: false };
  }
}

function setConfig(config) {
  var userProperties = PropertiesService.getUserProperties();
  Logger.log('setConfig');
  Logger.log(config);
  userProperties.setProperty('config', JSON.stringify(config));
  Logger.log(userProperties.getProperty('config'));

  uninstall();
  install(config);
}

function isInstalled() {
  return ScriptApp.getProjectTriggers().length != 0;
}

function install(config) {
  if (!isInstalled()) {
    if (config.debugTime) {
      ScriptApp.newTrigger('moveSnoozes').timeBased().everyMinutes(1).create();
      //stop it from spamming Gmail api
      ScriptApp.newTrigger('uninstall').timeBased()
        .after(10 * 60 * 1000 //milliseconds
              ).create();
    } else {
      ScriptApp.newTrigger('moveSnoozes').timeBased().atHour(9).nearMinute(0).everyDays(1).create();
      ScriptApp.newTrigger('moveHourlySnoozes').timeBased().everyHours(1).nearMinute(10).create();
    }
    if (config.calendarNotificationsToGuests) {
      ScriptApp.newTrigger('emailMatchingCalendarEvents').timeBased().everyMinutes(30).create();
    }
  }
  createOrGetLabels(config);
  setConfig(config);
}

function uninstall() {
  ScriptApp.getProjectTriggers().map(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
    //necessary for rate-limiting
    Utilities.sleep(1000);
  });
}

function doGet() {
  var t = HtmlService.createTemplateFromFile('ui');
  var config = getConfig();
  for (var key in config) t[key] = config[key];
  t.installed = isInstalled();
  return t.evaluate().setSandboxMode(HtmlService.SandboxMode.NATIVE);
}

function createOrGetLabels(config) {
  var existingLabels = {};
  GmailApp.getUserLabels().map(function(label) {
    existingLabels[label.getName()] = label;
  });  
  function getLabel(name) {
    return existingLabels[name] || GmailApp.createLabel(name);
  };
  var labels = {
    Snooze: getLabel('Snooze'),
    Unsnoozed: config.addUnsnoozed ? getLabel('Unsnoozed') : undefined,
    Hourly: getLabel("Snooze/Snooze an hour or two"),
  };
  for (var i = 1; i <= config.numDays; ++i) {    
    labels[i] = getLabel('Snooze/Snooze ' + i + ' days');
  }
  return labels;
}

function dateLabel(date) {
  //just returns the equiv of "20161206"
  return ([date.getFullYear(),
           (10 > (date.getMonth()+1) ? '0': ''),
           date.getMonth()+1,
           (10 > date.getDate() ? '0': ''),
           date.getDate()
          ].join(''))
}

function emailMatchingCalendarEvents() {
  // every 30min from 8-6, check to see if there's an event
  // 1. test for more guests (than just the author)
  // 2. test for (personal) email reminder set
  var DURATION_WINDOW = 30 * 60 * 1000; //30min
  var now = new Date();
  var hour = new Date(now.getTime() + DURATION_WINDOW);
  var events = CalendarApp.getEvents(now, hour, {author: Session.getActiveUser().getEmail()});
  for (var i=0; i<events.length; i++) {
    var evt = events[i];
    if (evt.getEmailReminders().length >= 1) {
      var guests = evt.getGuestList();
      if (guests.length >= 1) {
        var guestEmails = guests.map(function(g){
          if (g.getGuestStatus() != CalendarApp.GuestStatus.NO) {
            return g.getEmail();
          }
        }).filter(function(e){return e;});
        GmailApp.sendEmail(guestEmails.join(','),
                           "Event Reminder: " + evt.getTitle(),
                           ("Location: " + evt.getLocation()
                            + "\n\nDescription: " + evt.getDescription()
                            + "\n\n\n(sent with a GoogleAppScript: "
                            + ScriptApp.getService().getUrl()
                            + ")\n"
                           )
                          );
      }
    }
  }

}

function getMatchingDrafts(targetLabel, sendImmediately, returnJSON, hourDelay) {
  var rv = {"drafts":[], "labels":[]};
  var config = getConfig();
  var labels = createOrGetLabels(config);
  var drafts = GmailApp.getDraftMessages();
  var dateregex = new RegExp(dateLabel(new Date()));
  for (var i = 0; i < drafts.length; i++) {
    var msg = drafts[i];
    var msglabels = msg.getThread().getLabels();
    var shouldSend = false;
    for (var j = 0; j < msglabels.length; j++) {
      var labelName = msglabels[j].getName();
      rv.labels.push(labelName);
      if (targetLabel) {
        if (labelName == targetLabel) {
          shouldSend = true;
          break;
        }
      } else if (dateregex.test(labelName)
                 || labelName == labels[1].getName()) {
        //default logic if no targetLabel is specified
        shouldSend = true;
        break;
      }
    }
    if (shouldSend) {
      if (!hourDelay //note: draft getDate() returns last modified date
          || (new Date(msg.getDate()) < (new Date() - (60 * 60 * 1000)))) {
        if (sendImmediately) {
          dispatchDraft(msg, true);
        } else {
          rv.drafts.push(msg);
        }
      }
    }
  }
  if (returnJSON) {
    for (var k=0; k<rv.drafts.length; k++) {
      var d = rv.drafts[k];
      rv.drafts[k] = {to: msg.getTo(), date: msg.getDate(), subject: msg.getSubject()}
    }
    return JSON.stringify(rv);
  } else {
    return rv;
  }
}

function moveHourlySnoozes() {
  var config = getConfig();
  var labels = createOrGetLabels(config);
  getMatchingDrafts(labels.Hourly.getName(), true, false, true);

  var page = labels.Hourly.getThreads(0, 100);
  moveThread(config, labels, 'unindexed', page, labels.Hourly);
}

function moveSnoozes() { 
  var config = getConfig();
  var labels = createOrGetLabels(config);
  var oldLabel, newLabel, page;

  //FIRST DRAFTS TO SEND
  var draftsToSend = getMatchingDrafts().drafts;
  for (var d = 0; d < draftsToSend.length; d++) {
      dispatchDraft(draftsToSend[d]);
  }
  //SECOND THREADS TO UNSNOOZE
  /// targeting specific date
  var dateregex = new RegExp(dateLabel(new Date()));
  GmailApp.getUserLabels().map(function(label) {
    if (dateregex.test(label.getName())) {
      var page = label.getThreads(0, 100);
      moveThread(config, labels, 'unindexed', page, label);
    }
  });
  /// targeting days
  for (var i = 1; i <= config.numDays; ++i) {
    page = null;
    // Get threads in 'pages' of 100 at a time
    while(!page || page.length == 100) {
      page = labels[i].getThreads(0, 100);
      moveThread(config, labels, i, page, labels[i]);
    }
  }

}

function moveThread(config, labels, i, page, label) {
  if (page.length > 0) {
    if (i > 1) {
      // Move the threads into 'today’s' label
      labels[i - 1].addToThreads(page);
    } else {
      // Unless it’s time to unsnooze it
      GmailApp.moveThreadsToInbox(page);
      if (config.markUnread) {
        GmailApp.markThreadsUnread(page);
      }
      if (config.addUnsnoozed) {
        labels.Unsnoozed.addToThreads(page);
      }
    }
    // Move the threads out of 'yesterday’s' label
    label.removeFromThreads(page);
  }
}

function dispatchDraft(message, attachToThread) {
  try {
      var thread = message.getThread();
      var body = message.getBody();
      var raw  = message.getRawContent();
      /* Credit - YetAnotherMailMerge */
      var regMessageId = new RegExp(id, "g");
      if (body.match(regMessageId) != null) {
        var inlineImages = {};
        var nbrOfImg = body.match(regMessageId).length;
        var imgVars = body.match(/<img[^>]+>/g);
        var imgToReplace = [];
        if(imgVars != null){
          for (var i = 0; i < imgVars.length; i++) {
            if (imgVars[i].search(regMessageId) != -1) {
              var id = imgVars[i].match(/realattid=([^&]+)&/);
              if (id != null) {
                id = id[1];
                var temp = raw.split(id)[1];
                temp = temp.substr(temp.lastIndexOf('Content-Type'));
                var imgTitle = temp.match(/name="([^"]+)"/);
                var contentType = temp.match(/Content-Type: ([^;]+);/);
                contentType = (contentType != null) ? contentType[1] : "image/jpeg";
                var b64c1 = raw.lastIndexOf(id) + id.length + 3; // first character in image base64
                var b64cn = raw.substr(b64c1).indexOf("--") - 3; // last character in image base64
                var imgb64 = raw.substring(b64c1, b64c1 + b64cn + 1); // is this fragile or safe enough?
                var imgblob = Utilities.newBlob(Utilities.base64Decode(imgb64), contentType, id); // decode and blob
                if (imgTitle != null) imgToReplace.push([imgTitle[1], imgVars[i], id, imgblob]);
              }
            }
          }
        }
        for (var i = 0; i < imgToReplace.length; i++) {
          inlineImages[imgToReplace[i][2]] = imgToReplace[i][3];
          var newImg = imgToReplace[i][1].replace(/src="[^\"]+\"/, "src=\"cid:" + imgToReplace[i][2] + "\"");
          body = body.replace(imgToReplace[i][1], newImg);
        }
      }
      var options = {
        cc          : message.getCc(),
        bcc         : message.getBcc(),
        htmlBody    : body,
        replyTo     : message.getReplyTo(),
        inlineImages: inlineImages,
        name        : message.getFrom().match(/[^<]*/)[0].trim(),
        attachments : message.getAttachments()
      }

      // Unintuitive, but replyAll even works on orphan/original messages, and
      // for threads, it keeps it in the thread
      message.replyAll(body, options)
      //old way:
      //GmailApp.sendEmail(message.getTo(), message.getSubject(), body, options);

      message.moveToTrash();
      return "Delivered";
  } catch (e) {
    return e.toString();
  }
}
