use crate::config::{PrinterConfig, PrinterKind};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

const PRINT_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn print_raw(printer: &PrinterConfig, data: &[u8]) -> Result<(), String> {
    match printer.kind {
        PrinterKind::Network => print_network(&printer.host, printer.port, data).await,
        PrinterKind::Usb => print_usb(printer.printer_name.clone(), data.to_vec()).await,
    }
}

async fn print_network(host: &str, port: u16, data: &[u8]) -> Result<(), String> {
    let addr = format!("{host}:{port}");

    let connect = TcpStream::connect(&addr);
    let mut socket = timeout(PRINT_TIMEOUT, connect)
        .await
        .map_err(|_| format!("Timeout ao contactar a impressora {addr}"))?
        .map_err(|e| format!("Falha ao ligar à impressora {addr}: {e}"))?;

    timeout(PRINT_TIMEOUT, socket.write_all(data))
        .await
        .map_err(|_| format!("Timeout ao contactar a impressora {addr}"))?
        .map_err(|e| format!("Falha ao escrever na impressora {addr}: {e}"))?;

    socket
        .shutdown()
        .await
        .map_err(|e| format!("Falha ao fechar a ligação com {addr}: {e}"))?;

    Ok(())
}

#[cfg(windows)]
async fn print_usb(printer_name: String, data: Vec<u8>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || windows_print::print_raw_bytes(&printer_name, &data))
        .await
        .map_err(|e| format!("Falha interna ao imprimir: {e}"))?
}

#[cfg(not(windows))]
async fn print_usb(_printer_name: String, _data: Vec<u8>) -> Result<(), String> {
    Err("Impressão USB/local só é suportada no Windows.".into())
}

#[cfg(windows)]
pub fn list_printers() -> Result<Vec<String>, String> {
    windows_print::list_printers()
}

#[cfg(not(windows))]
pub fn list_printers() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// ESC/POS: init, texte, feed, cut.
pub fn test_ticket() -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(b"\x1b\x40"); // ESC @ (init)
    data.extend_from_slice(b"Qomanda Print Agent\n");
    data.extend_from_slice(b"Teste de impressao OK\n");
    data.extend_from_slice(b"\n\n\n");
    data.extend_from_slice(b"\x1d\x56\x00"); // GS V 0 (full cut)
    data
}

#[cfg(windows)]
mod windows_print {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_4W,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn wide_ptr_to_string(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0isize;
        while *ptr.offset(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len as usize);
        String::from_utf16_lossy(slice)
    }

    pub fn list_printers() -> Result<Vec<String>, String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            let mut needed: u32 = 0;
            let mut returned: u32 = 0;

            EnumPrintersW(flags, null_mut(), 4, null_mut(), 0, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }

            let mut buffer: Vec<u8> = vec![0u8; needed as usize];
            let ok = EnumPrintersW(
                flags,
                null_mut(),
                4,
                buffer.as_mut_ptr(),
                needed,
                &mut needed,
                &mut returned,
            );
            if ok == 0 {
                return Err("Falha ao listar as impressoras do Windows.".into());
            }

            let infos = std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
            Ok(infos
                .iter()
                .map(|info| wide_ptr_to_string(info.pPrinterName))
                .filter(|name| !name.is_empty())
                .collect())
        }
    }

    pub fn print_raw_bytes(printer_name: &str, data: &[u8]) -> Result<(), String> {
        unsafe {
            let mut wide_name = to_wide(printer_name);
            let mut handle: HANDLE = null_mut();
            if OpenPrinterW(wide_name.as_mut_ptr(), &mut handle, null_mut()) == 0 {
                return Err(format!("Não foi possível abrir a impressora \"{printer_name}\"."));
            }

            let mut doc_name = to_wide("Qomanda Ticket");
            let mut datatype = to_wide("RAW");
            let doc_info = DOC_INFO_1W {
                pDocName: doc_name.as_mut_ptr(),
                pOutputFile: null_mut(),
                pDatatype: datatype.as_mut_ptr(),
            };

            let job_id = StartDocPrinterW(handle, 1, &doc_info);
            if job_id == 0 {
                ClosePrinter(handle);
                return Err(format!("Falha ao iniciar o trabalho de impressão em \"{printer_name}\"."));
            }

            if StartPagePrinter(handle) == 0 {
                EndDocPrinter(handle);
                ClosePrinter(handle);
                return Err(format!("Falha ao iniciar a página de impressão em \"{printer_name}\"."));
            }

            let mut written: u32 = 0;
            let ok = WritePrinter(handle, data.as_ptr() as *const _, data.len() as u32, &mut written);

            EndPagePrinter(handle);
            EndDocPrinter(handle);
            ClosePrinter(handle);

            if ok == 0 || written as usize != data.len() {
                return Err(format!("Falha ao escrever na impressora \"{printer_name}\"."));
            }

            Ok(())
        }
    }
}
