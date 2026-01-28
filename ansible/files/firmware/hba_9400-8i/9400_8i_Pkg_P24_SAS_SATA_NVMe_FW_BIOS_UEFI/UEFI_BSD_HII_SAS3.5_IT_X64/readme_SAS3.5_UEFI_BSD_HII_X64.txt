***********************************************************************

Broadcom Inc SAS3.5 MPT IT UEFI BSD & HII Configuration Utility

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

Binary image name: mpt35sas_x64.rom.


Installation Instruction:
=========================

Use storcli.efi to install the SAS3.5 UEFI BSD & HII Configuration Utility.

UEFI version of storcli can be downloaded from the Support & Downloads section of www.broadcom.com

The command line installation instruction to flash the SAS3.5 UEFI BSD & HII Configuration Utility is:

storcli.efi /c<N> download efibios file=mpt35sas_x64.rom

where <N> is the controller number (starting with zero (0)).

If you need further help, please contact the Broadcom FAE associated with your Organization.

Notes:
1) The SAS3.5 UEFI BSD & HII Configuration Utility does not require Legacy BIOS to be loaded on to the controller.
2) The firmware in the controller should be fully operational for flashing the SAS3.5 UEFI BSD & HII Configuration Utility.
3) The release supports X64 platforms.
