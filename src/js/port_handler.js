'use strict';

const TIMEOUT_CHECK = 500 ; // With 250 it seems that it produces a memory leak and slowdown in some versions, reason unknown
const MDNS_INTERVAL = 10000;
const TCP_CHECK_INTERVAL = 5000;
const TCP_TIMEOUT = 2000;

const usbDevices = { filters: [
    {'vendorId': 1155, 'productId': 57105}, // STM Device in DFU Mode || Digital Radio in USB mode
    {'vendorId': 10473, 'productId': 393},  // GD32 DFU Bootloader
] };

const PortHandler = new function () {
    this.initialPorts = false;
    this.port_detected_callbacks = [];
    this.port_removed_callbacks = [];
    this.dfu_available = false;
    this.port_available = false;
    this.showAllSerialDevices = false;
    this.showVirtualMode = false;
};

PortHandler.initialize = function () {
    const portPickerElementSelector = "div#port-picker #port";
    this.portPickerElement = $(portPickerElementSelector);
    this.selectList = document.querySelector(portPickerElementSelector);
    this.initialWidth = this.selectList.offsetWidth + 12;

    // fill dropdown with version numbers
    generateVirtualApiVersions();

    const self = this;

    self.mdnsBrowser = {
        services: [],
        browser: null,
        init: false,
    };

    let bonjour = {};

    if (!self.mdnsBrowser.init) {
        if (GUI.isCordova()) {
            const zeroconf = cordova.plugins.zeroconf;
            zeroconf.registerAddressFamily = 'ipv4'; // or 'ipv6' ('any' by default)
            zeroconf.watchAddressFamily = 'ipv4'; // or 'ipv6' ('any' by default)
            zeroconf.watch("_http._tcp.", "local.", (result) => {
                const action = result.action;
                const service = result.service;
                if (['added', 'resolved'].includes(action)) {
                    console.log("Zeroconf Service Changed", service);
                    self.mdnsBrowser.services.push({
                        addresses: service.ipv4Addresses,
                        txt: service.txtRecord,
                        fqdn: service.hostname,
                    });
                } else {
                    console.log("Zeroconf Service Removed", service);
                    self.mdnsBrowser.services = mdnsBrowser.services.filter(s => s.fqdn !== service.hostname);
                }
            });
        } else {
            bonjour = require('bonjour')();
            self.mdnsBrowser.browser = bonjour.find({ type: 'http' }, function(service) {
                console.log("Found HTTP service", service);
                self.mdnsBrowser.services.push({
                    addresses: service.addresses,
                    txt: service.txt,
                    fqdn: service.host,
                });
            });
        }

        self.mdnsBrowser.init = true;
    }

    const tcpCheck = function() {
        if (!self.tcpCheckLock) {
            self.tcpCheckLock = true;
            if (self.initialPorts?.length > 0) {
                const tcpPorts = self.initialPorts.filter(p => p.path.startsWith('tcp://'));
                tcpPorts.forEach(function (port) {
                    const removePort = () => {
                        self.mdnsBrowser.services = self.mdnsBrowser.services.filter(s => s.fqdn !== port.fqdn);
                    };
                    $.get({
                        host: port.path.split('//').pop(),
                        port: 80,
                        timeout: TCP_TIMEOUT,
                    }, (res) => res.destroy())
                        .fail(removePort);
                });

                //timeout is 2000ms for every found port, so wait that time before checking again
                setTimeout(() => {
                    self.tcpCheckLock = false;
                }, Math.min(tcpPorts.length, 1) * (TCP_TIMEOUT + 1));
            } else {
                self.tcpCheckLock = false;
            }
        }

        setTimeout(() => {
            tcpCheck();
        }, TCP_CHECK_INTERVAL);
    };

    tcpCheck();

    if (self.mdns_timer) {
        clearInterval(self.mdns_timer);
    }

    self.mdns_timer = setInterval(() => {
        if (!GUI.connected_to && !GUI.isCordova() && self.mdnsBrowser.browser) {
            self.mdnsBrowser.browser.update();
        }
    }, MDNS_INTERVAL);

    this.reinitialize();    // just to prevent code redundancy
};

PortHandler.reinitialize = function () {
    this.initialPorts = false;
    if (this.usbCheckLoop) {
        clearTimeout(this.usbCheckLoop);
    }
    this.showVirtualMode = ConfigStorage.get('showVirtualMode').showVirtualMode;
    this.showAllSerialDevices = ConfigStorage.get('showAllSerialDevices').showAllSerialDevices;
    this.check();   // start listening, check after TIMEOUT_CHECK ms
};

PortHandler.check = function () {
    const self = this;

    if (!self.port_available) {
        self.check_usb_devices();
    }

    if (!self.dfu_available) {
        self.check_serial_devices();
    }

    self.usbCheckLoop = setTimeout(function () {
        self.check();
    }, TIMEOUT_CHECK);
};

PortHandler.check_serial_devices = function () {
    const self = this;

    serial.getDevices(function(cp) {

        let currentPorts = [
            ...cp,
            ...(self.mdnsBrowser?.services?.filter(s => s.txt.vendor === 'elrs' && s.txt.type === 'rx')
                .map(s => s.addresses.map(a => ({
                    path: `tcp://${a}`,
                    displayName: `${s.txt.target} - ${s.txt.version}`,
                    fqdn: s.fqdn,
                    vendorId: 0,
                    productId: 0,
                }))).flat() ?? []),
        ].filter(Boolean);

        // auto-select port (only during initialization)
        if (!self.initialPorts) {
            currentPorts = self.updatePortSelect(currentPorts);
            self.selectPort(currentPorts);
            self.initialPorts = currentPorts;
            GUI.updateManualPortVisibility();
        } else {
            self.removePort(currentPorts);
            self.detectPort(currentPorts);
        }
    });
};

PortHandler.check_usb_devices = function (callback) {
    const self = this;
    chrome.usb.getDevices(usbDevices, function (result) {

        const dfuElement = self.portPickerElement.children("[value='DFU']");
        if (result.length) {
            if (!dfuElement.length) {
                self.portPickerElement.empty();
                let usbText;
                if (result[0].productName) {
                    usbText = (`DFU - ${result[0].productName}`);
                } else {
                    usbText = "DFU";
                }

                self.portPickerElement.append($('<option/>', {
                    value: "DFU",
                    text: usbText,
                    data: {isDFU: true},
                }));

                self.portPickerElement.append($('<option/>', {
                    value: 'manual',
                    text: i18n.getMessage('portsSelectManual'),
                    data: {isManual: true},
                }));

                self.portPickerElement.val('DFU').trigger('change');
                self.setPortsInputWidth();
            }
            self.dfu_available = true;
        } else {
            if (dfuElement.length) {
               dfuElement.remove();
               self.setPortsInputWidth();
            }
            self.dfu_available = false;
        }
        if (callback) {
            callback(self.dfu_available);
        }
        if (!$('option:selected', self.portPickerElement).data().isDFU) {
            if (!(GUI.connected_to || GUI.connect_lock)) {
                FC.resetState();
            }
            if (self.dfu_available) {
                self.portPickerElement.trigger('change');
            }
        }
    });
};

PortHandler.removePort = function(currentPorts) {
    const self = this;
    const removePorts = self.array_difference(self.initialPorts, currentPorts);

    if (removePorts.length) {
        console.log(`PortHandler - Removed: ${JSON.stringify(removePorts)}`);
        self.port_available = false;
        // disconnect "UI" - routine can't fire during atmega32u4 reboot procedure !!!
        if (GUI.connected_to) {
            for (let i = 0; i < removePorts.length; i++) {
                if (removePorts[i].path === GUI.connected_to) {
                    $('div#header_btns a.connect').click();
                }
            }
        }
        // trigger callbacks (only after initialization)
        for (let i = (self.port_removed_callbacks.length - 1); i >= 0; i--) {
            const obj = self.port_removed_callbacks[i];

            // remove timeout
            clearTimeout(obj.timer);

            // trigger callback
            obj.code(removePorts);

            // remove object from array
            const index = self.port_removed_callbacks.indexOf(obj);
            if (index > -1) {
                self.port_removed_callbacks.splice(index, 1);
            }
        }
        for (let i = 0; i < removePorts.length; i++) {
            self.initialPorts.splice(self.initialPorts.indexOf(removePorts[i]), 1);
        }
        self.updatePortSelect(self.initialPorts);
        self.portPickerElement.trigger('change');
    }
};

PortHandler.detectPort = function(currentPorts) {
    const self = this;
    const newPorts = self.array_difference(currentPorts, self.initialPorts);

    if (newPorts.length) {
        currentPorts = self.updatePortSelect(currentPorts);
        console.log(`PortHandler - Found: ${JSON.stringify(newPorts)}`);

        if (newPorts.length === 1) {
            self.portPickerElement.val(newPorts[0].path);
        } else if (newPorts.length > 1) {
            self.selectPort(currentPorts);
        }

        self.port_available = true;
        // Signal board verification
        if (GUI.active_tab === 'firmware_flasher') {
            TABS.firmware_flasher.boardNeedsVerification = true;
        }

        self.portPickerElement.trigger('change');

        // auto-connect if enabled
        if (GUI.auto_connect && !GUI.connecting_to && !GUI.connected_to) {
            // start connect procedure. We need firmware flasher protection over here
            if (GUI.active_tab !== 'firmware_flasher') {
                $('div#header_btns a.connect').click();
            }
        }
        // trigger callbacks
        for (let i = (self.port_detected_callbacks.length - 1); i >= 0; i--) {
            const obj = self.port_detected_callbacks[i];

            // remove timeout
            clearTimeout(obj.timer);

            // trigger callback
            obj.code(newPorts);

            // remove object from array
            const index = self.port_detected_callbacks.indexOf(obj);
            if (index > -1) {
                self.port_detected_callbacks.splice(index, 1);
            }
        }
        self.initialPorts = currentPorts;
    }
};

PortHandler.sortPorts = function(ports) {
    return ports.sort(function(a, b) {
        return a.path.localeCompare(b.path, window.navigator.language, {
            numeric: true,
            sensitivity: 'base',
        });
    });
};

PortHandler.updatePortSelect = function (ports) {
    ports = this.sortPorts(ports);
    this.portPickerElement.empty();

    for (let i = 0; i < ports.length; i++) {
        let portText;
        if (ports[i].displayName) {
            portText = (`${ports[i].path} - ${ports[i].displayName}`);
        } else {
            portText = ports[i].path;
        }

        this.portPickerElement.append($("<option/>", {
            value: ports[i].path,
            text: portText,
            data: {isManual: false},
        }));
    }

    if (this.showVirtualMode) {
        this.portPickerElement.append($("<option/>", {
            value: 'virtual',
            text: i18n.getMessage('portsSelectVirtual'),
            data: {isVirtual: true},
        }));
    }

    this.portPickerElement.append($("<option/>", {
        value: 'manual',
        text: i18n.getMessage('portsSelectManual'),
        data: {isManual: true},
    }));

    this.setPortsInputWidth();
    return ports;
};

PortHandler.selectPort = function(ports) {
    const OS = GUI.operating_system;
    for (let i = 0; i < ports.length; i++) {
        const portName = ports[i].displayName;
        if (portName) {
            const pathSelect = ports[i].path;
            const isWindows = (OS === 'Windows');
            const isTty = pathSelect.includes('tty');
            const deviceRecognized = portName.includes('STM') || portName.includes('CP210') || portName.startsWith('SPR');
            const legacyDeviceRecognized = portName.includes('usb');
            if (isWindows && deviceRecognized || isTty && (deviceRecognized || legacyDeviceRecognized)) {
                this.portPickerElement.val(pathSelect);
                this.port_available = true;
                console.log(`Porthandler detected device ${portName} on port: ${pathSelect}`);
            }
        }
    }
};

PortHandler.setPortsInputWidth = function() {

    function findMaxLengthOption(selectEl) {
        let max = 0;

        $(selectEl.options).each(function () {
            const textSize = getTextWidth(this.textContent);
            if (textSize > max) {
                max = textSize;
            }
        });

        return max;
    }

    const correction = 32; // account for up/down button and spacing
    let width = findMaxLengthOption(this.selectList) + correction;

    width = (width > this.initialWidth) ? width : this.initialWidth;

    const portsInput = document.querySelector("div#port-picker #portsinput");
    portsInput.style.width = `${width}px`;
};

PortHandler.port_detected = function(name, code, timeout, ignore_timeout) {
    const self = this;
    const obj = {'name': name,
                 'code': code,
                 'timeout': (timeout) ? timeout : 10000,
                };

    if (!ignore_timeout) {
        obj.timer = setTimeout(function() {
            console.log(`PortHandler - timeout - ${obj.name}`);

            // trigger callback
            code(false);

            // remove object from array
            const index = self.port_detected_callbacks.indexOf(obj);
            if (index > -1) {
                self.port_detected_callbacks.splice(index, 1);
            }
        }, (timeout) ? timeout : 10000);
    } else {
        obj.timer = false;
        obj.timeout = false;
    }

    this.port_detected_callbacks.push(obj);

    return obj;
};

PortHandler.port_removed = function (name, code, timeout, ignore_timeout) {
    const self = this;
    const obj = {'name': name,
                 'code': code,
                 'timeout': (timeout) ? timeout : 10000,
                };

    if (!ignore_timeout) {
        obj.timer = setTimeout(function () {
            console.log(`PortHandler - timeout - ${obj.name}`);

            // trigger callback
            code(false);

            // remove object from array
            const index = self.port_removed_callbacks.indexOf(obj);
            if (index > -1) {
                self.port_removed_callbacks.splice(index, 1);
            }
        }, (timeout) ? timeout : 10000);
    } else {
        obj.timer = false;
        obj.timeout = false;
    }

    this.port_removed_callbacks.push(obj);

    return obj;
};

// accepting single level array with "value" as key
PortHandler.array_difference = function (firstArray, secondArray) {
    const cloneArray = [];

    // create hardcopy
    for (let i = 0; i < firstArray.length; i++) {
        cloneArray.push(firstArray[i]);
    }

    for (let i = 0; i < secondArray.length; i++) {
        const elementExists = cloneArray.findIndex(element => element.path === secondArray[i].path);
        if (elementExists !== -1) {
            cloneArray.splice(elementExists, 1);
        }
    }

    return cloneArray;
};

PortHandler.flush_callbacks = function () {
    let killed = 0;

    for (let i = this.port_detected_callbacks.length - 1; i >= 0; i--) {
        if (this.port_detected_callbacks[i].timer) {
            clearTimeout(this.port_detected_callbacks[i].timer);
        }
        this.port_detected_callbacks.splice(i, 1);

        killed++;
    }

    for (let i = this.port_removed_callbacks.length - 1; i >= 0; i--) {
        if (this.port_removed_callbacks[i].timer) {
            clearTimeout(this.port_removed_callbacks[i].timer);
        }
        this.port_removed_callbacks.splice(i, 1);

        killed++;
    }

    return killed;
};
