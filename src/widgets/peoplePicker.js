/**
 *
 * People Picker Pane
 *
 * This pane offers a mechanism for selecting a set of individuals, groups, or
 * organizations to take some action on.
 *
 * Assumptions
 *   - Assumes that the user has a type index entry for vcard:AddressBook.
 *
 */
import escape from 'escape-html'
import uuid from 'node-uuid'
import rdf from 'rdflib'
const webClient = require('solid-web-client')(rdf)

import { makeDropTarget } from './dragAndDrop'
import { errorMessageBlock } from './error'
import { iconBase } from '../iconBase'
import ns from '../ns'
import kb from '../store'

export class PeoplePicker {
  constructor (element, typeIndexUrl, groupPickedCb, selectedGroupNode) {
    this.element = element
    this.typeIndexUrl = typeIndexUrl
    this.groupPickedCb = groupPickedCb
    this.selectedGroupNode = selectedGroupNode
    this.onSelectGroup = this.onSelectGroup.bind(this)
  }

  render () {
    const container = document.createElement('div')
    container.style.maxWidth = '350px'
    container.style.minHeight = '200px'
    container.style.outline = '1px solid black'
    container.style.display = 'flex'

    if (this.selectedGroupNode) {
      const selectedGroup = document.createElement('div')
      new Group(selectedGroup, this.selectedGroupNode).render()
      const changeGroupButton = document.createElement('button')
      changeGroupButton.textContent = escape('Change group')
      changeGroupButton.addEventListener('click', event => {
        this.selectedGroupNode = null
        this.render()
      })
      container.appendChild(selectedGroup)
      container.appendChild(changeGroupButton)
    } else {
      this.findGroupIndex(this.typeIndexUrl)
        .then(({bookBaseUrl, groupIndexUrl, groupContainerUrl}) => {
          const chooseExistingGroupButton = document.createElement('button')
          chooseExistingGroupButton.textContent = escape('Pick an existing group')
          chooseExistingGroupButton.addEventListener('click', event => {
            new GroupPicker(container, bookBaseUrl, groupIndexUrl, this.onSelectGroup).render()
          })

          const createNewGroupButton = document.createElement('button')
          createNewGroupButton.textContent = escape('Create a new group')
          createNewGroupButton.addEventListener('click', event => {
            this.createNewGroup(bookBaseUrl)
              .then(({groupNode, graphNode}) => {
                new GroupBuilder(
                  this.element,
                  graphNode,
                  groupNode,
                  this.onSelectGroup
                ).render()
              })
              .catch(errorBody => {
                this.element.appendChild(
                  errorMessageBlock(document, escape(`Error creating a new group. (${errorBody})`))
                )
              })
          })

          container.appendChild(chooseExistingGroupButton)
          container.appendChild(createNewGroupButton)

          this.element.innerHTML = ''
          this.element.appendChild(container)
        })
        .catch(err => {
          this.element.appendChild(
            errorMessageBlock(document, escape(`Could find your groups. (${err})`))
          )
        })
    }

    this.element.innerHTML = ''
    this.element.appendChild(container)
    return this
  }

  findGroupIndex (typeIndexUrl) {
    return new Promise((resolve, reject) => {
      kb.fetcher.nowOrWhenFetched(typeIndexUrl, (ok, err) => {
        if (!ok) {
          return reject(err)
        }
        const bookRegistrations = kb.statementsMatching(null, ns.solid('forClass'), ns.vcard('AddressBook'))
        if (bookRegistrations.length < 1) {
          return reject(new Error('no address book registered in the solid type index'))
        }
        // According to vcard footprint (https://www.w3.org/2015/03/vcard-footprint/footprint.html),
        // vcard:AddressBook should be listed in the the base URI $b/book.ttl
        const registrationSubject = bookRegistrations[0].subject
        const instance = kb.statementsMatching(
          registrationSubject,
          ns.solid('instance')
        )
        if (!instance.length) {
          reject(new Error('incomplete address book registration'))
        }
        // We've found an address book
        const bookUrl = instance[0].object.value
        const bookBaseUrl = bookUrl.replace(/book\.ttl(#.*)?$/, '')
        const groupIndexUrl = `${bookBaseUrl}groups.ttl`
        const groupContainerUrl = `${bookBaseUrl}Group/`
        return resolve({bookBaseUrl, groupIndexUrl, groupContainerUrl})
      })
    })
  }

  createNewGroup (bookBaseUrl) {
    const groupIndexNode = rdf.namedNode(`${bookBaseUrl}groups.ttl`)
    const graphUrl = `${bookBaseUrl}Group/${uuid.v4().slice(0, 8)}.ttl`
    const groupGraphNode = rdf.namedNode(graphUrl)
    const groupNode = rdf.namedNode(`${graphUrl}#this`)
    // NOTE that order matters here.  Unfortunately this type of update is
    // non-atomic in that solid requires us to send two PATCHes, either of which
    // might fail.
    const patchPromises = [groupGraphNode, groupIndexNode]
      .map(namedGraph => {
        const typeStatement = rdf.st(groupNode, ns.rdf('type'), ns.vcard('Group'), namedGraph)
        const nameStatement = rdf.st(groupNode, ns.vcard('fn'), 'Untitled Group', namedGraph)
        return webClient.patch(namedGraph.value, [], [typeStatement, nameStatement])
          .then(() => kb.add([typeStatement, nameStatement]))
      })
    return Promise.all(patchPromises)
      .then(() => ({groupNode, groupGraphNode}))
      .catch(err => {
        throw new Error(`Couldn't create new group.  PATCH failed for (${err.xhr.responseURL})`)
      })
  }

  onSelectGroup (groupNode) {
    this.selectedGroupNode = groupNode
    this.render()
  }
}

export class GroupPicker {
  constructor (element, bookBaseUrl, groupIndexUrl, onSelectGroup) {
    this.element = element
    this.bookBaseUrl = bookBaseUrl
    this.groupIndexUrl = groupIndexUrl
    this.onSelectGroup = onSelectGroup
  }

  render () {
    this.loadGroups()
      .then(groupNodes => {
        // render the groups
        const container = document.createElement('div')
        groupNodes.forEach(group => {
          const groupContainer = document.createElement('div')
          groupContainer.style.display = 'flex'
          const groupButton = document.createElement('button')
          groupButton.addEventListener('click', this.handleClickGroup(group))
          new Group(groupButton, group).render()
          groupContainer.appendChild(groupButton)
          container.appendChild(groupContainer)
        })
        this.element.innerHTML = ''
        this.element.appendChild(container)
      })
      .catch(err => {
        this.element.appendChild(
          errorMessageBlock(document, escape(`There was an error loading your groups. (${err})`))
        )
      })
    return this
  }

  loadGroups () {
    return new Promise((resolve, reject) => {
      kb.fetcher.nowOrWhenFetched(this.groupIndexUrl, (ok, err) => {
        if (!ok) {
          return reject(err)
        }
        const groupNodes = kb.match(
          rdf.namedNode(`${this.bookBaseUrl}book.ttl#this`),
          ns.vcard('includesGroup')
        ).map(st => st.object)
        return resolve(groupNodes)
      })
    })
  }

  handleClickGroup (group) {
    return event => {
      this.onSelectGroup(group)
    }
  }
}

export class Group {
  constructor (element, groupNode) {
    this.element = element
    this.groupNode = groupNode
  }

  render () {
    const container = document.createElement('div')
    container.textContent = escape(
      getWithDefault(this.groupNode, ns.vcard('fn'), `[${this.groupNode.value}]`)
    )
    this.element.innerHTML = ''
    this.element.appendChild(container)
    return this
  }
}

export class GroupBuilder {
  constructor (element, groupGraph, groupNode, doneBuildingCb, groupChangedCb) {
    this.element = element
    this.groupGraph = groupGraph
    this.groupNode = groupNode
    this.onGroupChanged = (err, changeType, agent) => {
      if (groupChangedCb) {
        groupChangedCb(err, changeType, agent)
      }
    }
    this.groupChangedCb = groupChangedCb
    this.doneBuildingCb = doneBuildingCb
  }

  refresh () {
    // TODO: implement
  }

  render () {
    const dropContainer = document.createElement('div')
    dropContainer.style.maxWidth = '350px'
    dropContainer.style.minHeight = '200px'
    dropContainer.style.outline = '1px solid black'
    dropContainer.style.display = 'flex'
    dropContainer.style.flexDirection = 'column'

    makeDropTarget(dropContainer, uris => {
      uris.map(uri => {
        this.add(uri)
          .catch(() => {
            this.element.appendChild(
              errorMessageBlock(document, escape('Could not load the given WebId'))
            )
          })
      })
    })

    const groupNameInput = document.createElement('input')
    groupNameInput.type = 'text'
    groupNameInput.value = getWithDefault(this.groupNode, ns.vcard('fn'), 'Untitled Group')
    groupNameInput.addEventListener('input', event => {
      this.setGroupName(event.target.value)
    })
    const groupNameLabel = document.createElement('label')
    groupNameLabel.textContent = escape('Group Name:')
    groupNameLabel.appendChild(groupNameInput)
    dropContainer.appendChild(groupNameLabel)

    if (kb.any(this.groupNode, ns.vcard('hasMember'))) {
      kb.match(this.groupNode, ns.vcard('hasMember'))
        .forEach(statement => {
          const webIdNode = statement.object
          const personDiv = document.createElement('div')
          new Person(personDiv, webIdNode, this.handleRemove(webIdNode)).render()
          dropContainer.appendChild(personDiv)
        })
    } else {
      const copy = document.createElement('p')
      copy.textContent = escape`
        To add someone to this group, drag and drop their WebID URL onto the box.
      `
      dropContainer.appendChild(copy)
    }

    const doneBuildingButton = document.createElement('button')
    doneBuildingButton.textContent = escape('Done')
    doneBuildingButton.addEventListener('click', event => {
      this.doneBuildingCb(this.groupNode)
    })
    dropContainer.appendChild(doneBuildingButton)

    this.element.innerHTML = ''
    this.element.appendChild(dropContainer)
    return this
  }

  add (webId) {
    return new Promise((resolve, reject) => {
      kb.fetcher.nowOrWhenFetched(webId, (ok, err) => {
        if (!ok) {
          this.onGroupChanged(err)
          reject(err)
        } else {
          // make sure it's a valid person, group, or entity (for now just handle
          // webId)
          const webIdNode = rdf.namedNode(webId)
          const rdfClass = kb.any(webIdNode, ns.rdf('type'))
          if (!rdfClass || !rdfClass.equals(ns.foaf('Person'))) {
            reject(new Error('Only people supported right now'))
          }
          // TODO: sync this back to the server
          const statement = [this.groupNode, ns.vcard('hasMember'), webIdNode, this.groupGraph]
          if (kb.match(...statement).length < 1) {
            kb.add(...statement)
            // TODO: sync
          }
          this.onGroupChanged(null, 'added', webIdNode)
          resolve(webIdNode)
          this.render()
        }
      })
    })
  }

  handleRemove (webIdNode) {
    return event => {
      try {
        kb.remove(rdf.st(this.groupNode, ns.vcard('hasMember'), webIdNode, this.groupGraph))
        // TODO: sync
        this.onGroupChanged(null, 'removed', webIdNode)
      } catch (err) {
        const name = kb.any(webIdNode, ns.foaf('name'))
        this.element.appendChild(
          name && name.value
            ? errorMessageBlock(document, escape(`Could not remove ${name.value}`))
            : errorMessageBlock(document, escape(`Could not remove ${webIdNode.value}`))
        )
      }
      this.render()
      return true
    }
  }

  setGroupName (name) {
    kb.match(this.groupNode, ns.vcard('fn')).forEach(st => {
      kb.remove(st)
      kb.add(this.groupNode, ns.vcard('fn'), rdf.literal(name), st.why)
      // TODO: sync
    })
  }
}

class Person {
  constructor (element, webIdNode, handleRemove) {
    this.webIdNode = webIdNode
    this.element = element
    this.handleRemove = handleRemove
  }

  render () {
    const container = document.createElement('div')
    container.style.display = 'flex'

    // TODO: take a look at UI.widgets.setName
    const imgSrc = getWithDefault(this.webIdNode, ns.foaf('img'), iconBase + 'noun_15059.svg')
    const profileImg = document.createElement('img')
    profileImg.src = escape(imgSrc)
    profileImg.width = '50'
    profileImg.height = '50'
    profileImg.style.margin = '5px'

    // TODO: take a look at UI.widgets.setImage
    const name = getWithDefault(this.webIdNode, ns.foaf('name'), `[${this.webIdNode}]`)
    const nameSpan = document.createElement('span')
    nameSpan.innerHTML = escape(name)
    nameSpan.style.flexGrow = '1'
    nameSpan.style.margin = 'auto 0'

    const removeButton = document.createElement('button')
    removeButton.textContent = 'Remove'
    removeButton.addEventListener('click', event => this.handleRemove())
    removeButton.style.margin = '5px'

    container.appendChild(profileImg)
    container.appendChild(nameSpan)
    container.appendChild(removeButton)

    this.element.innerHTML = ''
    this.element.appendChild(container)
    return this
  }
}

function getWithDefault (subject, predicate, defaultValue) {
  const object = kb.any(subject, predicate)
  return object ? object.value : defaultValue
}
