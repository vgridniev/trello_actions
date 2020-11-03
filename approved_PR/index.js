const util = require('util');
const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

const supportedEvent = 'pull_request_review'
const supportedActions = ['submitted'];

// const supportedEvent = 'pull_request';
// const supportedActions = ['opened', 'reopened', 'edited'];


//configured in workflow file, which in turn should use repo secrets settings
const trelloKey = core.getInput('trello-key', { required: true });
const trelloToken = core.getInput('trello-token', { required: true });
//adds extra (redundant) PR comment, to mimic normal behavior of trello GH powerup
const shouldAddPrComment = core.getInput('add-pr-comment') === 'true';
//token is NOT magically present in context as some docs seem to indicate - have to supply in workflow yaml to input var
const ghToken = core.getInput('repo-token');

const evthookPayload = github.context.payload;

const trelloClient = axios.create({
  baseURL: 'https://api.trello.com',
});

const requestTrello = async (verb, url, body = null, extraParams = null) => {
  try {
    const params = {
        ...(extraParams || {}),
        key: trelloKey, 
        token: trelloToken    
    };
    
    const res = await trelloClient.request({
        method: verb,
        url: url,
        data: body || {}, 
        params: params
    });  
    core.debug(`${verb} to ${url} completed with status: ${res.status}.  data follows:`);
    //BRH NOTE core.xxx logging methods explode with typeerror when given non-string object.  TODO wrap.
    core.debug(util.inspect(res.data));
    return res.data;
  } catch(err) {
    core.error(`${verb} to ${url} errored: ${err}`);
    if(err.response) {
      core.error(util.inspect(err.response.data));
    }
    throw err;  
  }
};

const getCard = async (cardId) => {
  return requestTrello('get', `/1/cards/${cardId}`);
};

const getIdListByName = async (name, boardId) => {
   const listsBoard = await requestTrello('get', `/1/boards/${boardId}/lists`);
   const item = listsBoard.find(el => el.name === name)
    return item? item.id:null
};

const mostCardInNewList = async (cardId, listId) => {
   await requestTrello('put', `/1/cards/${cardId}`, {idList: listId});
}

const octokit = new github.GitHub(ghToken);

const baseIssuesArgs = {
    owner: (evthookPayload.organization || evthookPayload.repository.owner).login,
    repo: evthookPayload.repository.name,
    issue_number: evthookPayload.pull_request.number
};


const extractTrelloCardIds = (prBody, stopOnNonLink = true) =>   {
  core.debug(`prBody: ${util.inspect(prBody)}`);
  
  // browsers submit textareas with \r\n line breaks on all platforms
  const browserEol = '\r\n';
  // requires that link be alone own line, and allows leading/trailing whitespace
  const linkRegex = /^\s*(https\:\/\/trello\.com\/c\/(\w+))?\s*$/;
  
  const cardIds = [];
  const lines = prBody.split(browserEol);

  //loop and gather up cardIds, skipping blank lines. stopOnNonLink == true will bust out when we're out of link-only territory.
  for(const line of lines) {
    const matches = linkRegex.exec(line);
    if(matches) {
      if(matches[2]) {
        core.debug(`found id ${matches[2]}`);
        cardIds.push(matches[2]);
      }
    } else if(stopOnNonLink) {
      core.debug('matched something non-blank/link.  stopping search');
      break;
    }
  };
  return cardIds;
}

(async () => {
  try {
    if(!(github.context.eventName === supportedEvent && supportedActions.some(el => el === evthookPayload.action))) {
       core.info(`event/type not supported: ${github.context.eventName.eventName}.${evthookPayload.action}.  skipping action.`);
       return;
    }
      const cardIds = extractTrelloCardIds(evthookPayload.pull_request.body);

      if(cardIds && cardIds.length > 0) {
          for(const cardId of cardIds) {
              const card= await getCard(cardId);
              const idNewList = await getIdListByName('ready to deploy ( until 13)',card.idBoard);
              const pullRequest  = await octokit.pulls.get({
                  owner: "oversecured",
                  repo: evthookPayload.pull_request.base.repo.name,
                  pull_number: evthookPayload.pull_request.number,
              });
              console.log("pullRequest ====>", pullRequest)
              if(pullRequest.data.mergeable_state === 'unstable' || pullRequest.data.mergeable_state === 'clean'){
                  mostCardInNewList(cardId,idNewList).then(() => {
                      core.info(`Move card to new list trello`);
                  })
              } else {
                  console.log("Status", pullRequest.data.mergeable_state)
              }

          };
      } else {
          core.info(`no card urls in pr comment. nothing to do.`);
      }

  } catch (error) {
    core.error(util.inspect(error));
    //failure will stop PR from being mergeable if that setting enabled on the repo.  there is not currently a neutral exit in actions v2.
    core.setFailed(error.message);
  }
})();
