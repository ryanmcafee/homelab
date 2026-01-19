***********************************************************************

Broadcom Inc SAS3.5 MPT IT BIOS

***********************************************************************

Supported Chip Names:
=====================

SAS3408
SAS3508
SAS3508_1
SAS3416
SAS3516
SAS3516_1
SAS3616

Release Component:
==================

Binary image name: mpt35sas_legacy.rom.


Installation Instruction:
=========================

Use storcli.efi to install the SAS3.5 BIOS.

The storcli utility can be downloaded from the Support & Downloads section of www.broadcom.com

The command line installation instruction to flash the SAS3.5 BIOS is:

storcli.efi /c<N> download bios file = mpt35sas_legacy.rom

where <N> is the controller number (starting with zero (0)).

If you need further help, please contact the Broadcom FAE associated with your Organization.