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
  return JSON.parse(ScriptProperties.getProperty('config')) ||
    { numDays: 7, markUnread: false, addUnsnoozed: false, debugTime: false };
}

function setConfig(config) {
  ScriptProperties.setProperty('config', JSON.stringify(config));
}

function isInstalled() {
  return ScriptApp.getProjectTriggers().length != 0;
}

function install(config) {
  if (!isInstalled()) {
    if (config.debugTime) {
      ScriptApp.newTrigger('moveSnoozes').timeBased().everyMinutes(1).create();
    } else {
      ScriptApp.newTrigger('moveSnoozes').timeBased().atHour(9).nearMinute(0).everyDays(1).create();
    }
  }
  createOrGetLabels(config);
  setConfig(config);
}

function uninstall() {
  ScriptApp.getProjectTriggers().map(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
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

function getMatchingDrafts() {
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
      if (dateregex.test(labelName)
          || labelName == labels[1].getName()) {
        shouldSend = true;
        break;
      }
    }
    if (shouldSend) {
      rv.drafts.push(msg);
    }
  }
  return rv;
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
  for (var i = 1; i <= config.numDays; ++i) {
    page = null;
    // Get threads in 'pages' of 100 at a time
    while(!page || page.length == 100) {
      page = labels[i].getThreads(0, 100);
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
        labels[i].removeFromThreads(page);
      }  
    }
  }

}

function dispatchDraft(message) {
  try {
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
      GmailApp.sendEmail(message.getTo(), message.getSubject(), body, options);
      message.moveToTrash();
      return "Delivered";
  } catch (e) {
    return e.toString();
  }
}
